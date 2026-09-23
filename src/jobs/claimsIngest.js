const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const { getDatabase } = require('../database');
const { getCurrentPipelineStatus } = require('../pipeline');
const { createAuthedClient } = require('../lib/authtedClient');
const { runDirName } = require('../lib/utils');
const youtubeReporting = require('../lib/youtubeReporting');

const { raiseAlert, clearAlert } = require('../lib/serviceAlerts');

const connectVPN = require('../steps/connect-vpn');
const disconnectVPN = require('../steps/disconnect-vpn');
const validateInputCSVs = require('../steps/validate-input-csvs');
const processClaims = require('../steps/process-claims');
const enrichShorts = require('../steps/enrich-shorts');
const exportViews = require('../steps/export-views');


/**
 * Daily claims ingest: loads the newest YouTube Reporting API claims report per
 * content owner into youtube_mcn_claims, then refreshes YT-Validator's ASR queue
 * with the current unprocessed claims (POST /asr/queue).
 *
 * Deliberately NOT a pipeline run: no /predict, no Drive upload, no Slack, and no
 * YouTube Data API calls (the unprocessed export skips the availability lookup).
 * Every attempt is recorded in the claims_report_ingestions collection.
 */

const COLLECTION = 'claims_report_ingestions';
const DOWNLOAD_DIR = process.env.CLAIMS_REPORT_DIR || path.join(process.cwd(), 'data', 'claims-reports');
const STALE_AFTER_MS = (parseInt(process.env.PIPELINE_TIMEOUT_MINUTES) || 60) * 60 * 1000;
// Linked from the recorded error and the Slack alert, so whoever is paged lands
// on the steps rather than having to find the repo first.
const REAUTH_DOC_URL = 'https://github.com/JesusFilm/ytdt-claims-pipeline/blob/main/docs/' +
  'claims-reporting-api.md#when-google-asks-for-sign-in-again';
const LOGIN_HINT = process.env.YT_REPORTING_LOGIN_HINT || 'the content-manager account';
// One key for the whole ingest: an outage is one message, whatever caused it.
const INGEST_ALERT = 'claims-ingest';

let running = false;


// Report downloads are named `<source>_<YYYY-MM-DD>_<reportId>.csv`. Only
// those are removed: never subdirectories, never anything else someone left in
// the directory, and never through a symlink.
const REPORT_FILE = new RegExp(
  `^(${Object.keys(youtubeReporting.CLAIMS_OWNERS).join('|')})_\\d{4}-\\d{2}-\\d{2}_\\d+\\.csv$`
);

// Called after a successful run. Clearing only that run's own files meant a
// failed run's downloads were never removed, though the call site promised the
// next successful run would; at ~1 GB a report, a few failures would fill the
// disk unnoticed.
async function removeReportDownloads(dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const removed = [];
  for (const entry of entries) {
    if (!entry.isFile() || !REPORT_FILE.test(entry.name)) continue;
    await fs.promises.rm(path.join(dir, entry.name), { force: true });
    removed.push(entry.name);
  }
  if (removed.length) console.log(`claims ingest: removed ${removed.length} report download(s)`);
  return removed;
}


// True while an ingest holds the VPN/MySQL, in this process or another one
// (e.g. the manual script). A crashed ingest stops counting after the timeout.
async function isClaimsIngestRunning() {
  if (running) return true;
  const active = await getDatabase().collection(COLLECTION).findOne({
    status: 'running',
    startedAt: { $gt: new Date(Date.now() - STALE_AFTER_MS) }
  });
  return !!active;
}

async function postAsrQueue(filePath) {
  if (!process.env.ML_API_ENDPOINT) {
    throw new Error('ML_API_ENDPOINT is not set; cannot refresh the ASR queue');
  }
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));

  const client = await createAuthedClient(process.env.ML_API_ENDPOINT, { timeout: 120000 });
  const { data } = await client.post('/asr/queue', form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity
  });
  return data;
}

// Newest report per owner that has not been ingested yet.
async function findNewReports(auth, collection) {
  const pending = {};
  for (const [source, contentOwnerId] of Object.entries(youtubeReporting.CLAIMS_OWNERS)) {
    const reports = await youtubeReporting.listClaimsReports(auth, contentOwnerId);
    const newest = reports[reports.length - 1];
    if (!newest) {
      console.log(`claims ingest: no reports available for ${source}`);
      continue;
    }

    const done = await collection.findOne({ status: 'completed', [`reports.${source}.reportId`]: newest.id });
    if (done) {
      console.log(`claims ingest: ${source} report ${newest.startTime} already ingested`);
      continue;
    }
    pending[source] = {
      contentOwnerId,
      reportId: newest.id,
      jobId: newest.jobId,
      startTime: newest.startTime,
      createTime: newest.createTime,
      downloadUrl: newest.downloadUrl
    };
  }
  return pending;
}

// Failures at the credentials stage. The remedy differs — see describeFailure —
// but all of them stop claims arriving until a person acts.
const AUTH_REASONS = [
  'invalid_grant',            // token expired, revoked, or clock skew
  'invalid_client',
  'unauthorized_client',
  'invalid_scope',
  'access_not_configured',    // the stored grant refused; occasionally a policy block
];

// Google's token endpoint answers every refusal with 400, whatever the cause,
// so a 400 from there is an auth failure even when the reason is unfamiliar.
function isTokenEndpointFailure(error) {
  const url = error.response?.config?.url || error.config?.url || '';
  return error.response?.status === 400 && /oauth2\.googleapis\.com\/token/.test(url);
}

function isAuthError(error) {
  const reason = error.response?.data?.error;
  const status = error.response?.status;
  return AUTH_REASONS.includes(reason) ||
    status === 401 || status === 403 ||
    isTokenEndpointFailure(error) ||
    (error.code === 'ENOENT' && error.path === process.env.YT_REPORTING_TOKEN_FILE) ||
    /invalid_grant|YT_REPORTING_TOKEN_FILE|YouTube Reporting credentials/.test(error.message);
}

// What to tell whoever reads the alert. Nearly every credentials failure is
// fixed by signing in again; a policy block needs an admin instead, and the two
// are indistinguishable here — only attempting the sign-in separates them.
function describeFailure(error, { authRequired }) {
  const data = error.response?.data || {};
  const reason = data.error;
  const detail = [data.error_description, data.error_uri].filter(Boolean).join(' — ');

  if (reason === 'access_not_configured') {
    // 2026-09-23: this was read as Workspace having YouTube switched off for the
    // account, and it was not — re-authorizing fixed it, with no admin involved.
    // The two look identical from here, so say the cheap remedy first and give
    // the expensive one its own test: whether the sign-in itself is refused.
    return {
      lead: ':key: *Daily claims ingest needs re-authorization*',
      short: `Google refused the stored sign-in for ${LOGIN_HINT} (${reason}` +
        `${data.error_description ? `: ${data.error_description}` : ''}). Re-authorize from a laptop, not the ` +
        `VM: run scripts/youtube-reporting-auth.js, then install the token. Steps: ${REAUTH_DOC_URL}`,
      body: `Google refused the stored sign-in for ${LOGIN_HINT}: ${reason}${detail ? ` (${detail})` : ''}.\n` +
        `Sign in again — about 5 minutes, from a laptop rather than the VM: ${REAUTH_DOC_URL}\n` +
        'If the consent flow itself is refused rather than the stored grant, it is a policy block instead: ' +
        'a Workspace admin has to allow the app or re-enable YouTube for that account. Either way nothing ' +
        'needs backfilling — each report is a full snapshot, so the next run catches up on its own.'
    };
  }
  if (authRequired) {
    return {
      lead: ':key: *Daily claims ingest needs re-authorization*',
      short: `YouTube rejected the stored sign-in (${error.message}). Re-authorize from a laptop, not the VM: ` +
        `run scripts/youtube-reporting-auth.js, then pipe the token to the VM. Steps: ${REAUTH_DOC_URL}`,
      body: `${error.message}\n` +
        `Claims stop arriving until someone signs in again as ${LOGIN_HINT}. About 5 minutes, from a laptop ` +
        `rather than the VM: ${REAUTH_DOC_URL}`
    };
  }
  return {
    lead: ':warning: *Daily claims ingest failed*',
    short: error.message,
    body: `${error.message}\n` +
      'No claims were collected. The next scheduled run will try again; if it is failing for a reason ' +
      'nobody has seen before, the VM journal for ytdt-claims-pipeline has the detail.'
  };
}

async function runClaimsIngest({ trigger = 'schedule', dryRun = false } = {}) {
  const collection = getDatabase().collection(COLLECTION);

  if (await isClaimsIngestRunning()) {
    console.log('claims ingest: another ingest is running, skipping');
    return { status: 'skipped', reason: 'claims ingest already running' };
  }

  // Skip rather than wait: a missed day only delays caption lookups.
  const pipelineState = await getCurrentPipelineStatus();
  if (pipelineState.running) {
    const reason = `pipeline run ${pipelineState.runId} is active`;
    console.log(`claims ingest: ${reason}, skipping`);
    if (!dryRun) {
      await collection.insertOne({ trigger, status: 'skipped', reason, startedAt: new Date(), endedAt: new Date() });
    }
    return { status: 'skipped', reason };
  }

  running = true;
  const record = { trigger, status: 'running', startedAt: new Date(), reports: {}, results: {}, error: null };
  const context = {
    files: { claims: {} },
    options: {},
    connections: {},
    outputs: {},
    status: 'starting',
    startTime: Date.now()
  };
  let recordId = null;
  let failure = null;
  let stage = 'reporting'; // credentials are only exercised before the database stage

  try {
    if (!dryRun) {
      // Insert a copy: insertOne adds _id to the object, and record is $set later
      recordId = (await collection.insertOne({ ...record })).insertedId;
    }

    const auth = youtubeReporting.createAuth();
    const pending = await findNewReports(auth, collection);
    for (const [source, report] of Object.entries(pending)) {
      const { downloadUrl, ...meta } = report;
      record.reports[source] = meta;
    }

    if (dryRun) {
      record.status = 'dry_run';
      return record;
    }
    if (!Object.keys(pending).length) {
      record.status = 'nothing_new';
      return record;
    }

    for (const [source, report] of Object.entries(pending)) {
      const dest = path.join(DOWNLOAD_DIR, `${source}_${report.startTime.slice(0, 10)}_${report.reportId}.csv`);
      console.log(`claims ingest: downloading ${source} report ${report.startTime}`);
      await youtubeReporting.downloadReport(auth, report, dest);
      context.files.claims[source] = dest;
    }

    stage = 'database';
    await connectVPN(context);
    await validateInputCSVs(context);

    for (const source of Object.keys(context.files.claims)) {
      await processClaims(context, source);
    }
    record.results.claimsProcessed = Object.fromEntries(
      Object.entries(context.outputs.claimsProcessed || {}).map(([source, r]) => [source, {
        total: r.total,
        new: r.new,
        invalidMCIDs: r.invalidMCIDs?.length || 0,
        invalidLanguageIDs: r.invalidLanguageIDs?.length || 0
      }])
    );

    // enrich_shorts only looks at rows touched today, so it has to run here:
    // a later monthly run would no longer see these claims as new.
    await enrichShorts(context);
    record.results.enrichShorts = context.outputs.enrichShorts;

    context.options = {
      exportViews: ['export_unprocessed_claims'],
      // licensed and media_component_id are joins against local CSVs and cost
      // nothing; only video_available would spend Data API quota shared with
      // production. YT-Validator defers licensed claims to the end of the ASR
      // queue (~18% of lookups), so the column pays for itself.
      skipAvailability: true,
      exportDir: path.join(process.cwd(), 'data', 'exports', 'claims-ingest', runDirName(context.startTime))
    };
    await exportViews(context);

    const unprocessed = context.outputs.exports?.export_unprocessed_claims;
    record.results.asrQueue = unprocessed
      ? { rows: unprocessed.rows, path: unprocessed.path, response: await postAsrQueue(unprocessed.path) }
      : { skipped: 'no unprocessed claims exported' };

    record.status = 'completed';
    return record;

  } catch (error) {
    failure = error;
    record.status = 'failed';
    record.authRequired = stage === 'reporting' && isAuthError(error);
    // The recorded error says what to do about it, not just what broke: the
    // console shows this on the ingest card, and the remedy differs per cause.
    record.error = describeFailure(error, { authRequired: record.authRequired }).short;
    console.error('claims ingest failed:', error);
    return record;

  } finally {
    try {
      await disconnectVPN(context);
    } catch (err) {
      console.error('claims ingest: failed to disconnect VPN:', err);
    }

    // The API keeps reports for ~60 days, so a successful load needs no local copy.
    // Failed downloads stay for inspection until the next successful run.
    if (record.status === 'completed') {
      await removeReportDownloads(DOWNLOAD_DIR);
    }

    record.endedAt = new Date();
    if (recordId) {
      await collection.updateOne({ _id: recordId }, { $set: record });
      // Every failure is announced, not only the ones we can classify: an
      // access_not_configured block ran for two days in silence because it
      // matched no predicate. A run that works again closes the alert.
      if (record.status === 'failed' && failure) {
        const { lead, body } = describeFailure(failure, { authRequired: !!record.authRequired });
        await raiseAlert(INGEST_ALERT, `${lead}\n${body}`);
      } else if (['completed', 'nothing_new'].includes(record.status)) {
        await clearAlert(INGEST_ALERT);
      }
    }
    running = false;
    console.log(`claims ingest: ${record.status}`);
  }
}


// Milliseconds from `now` until the next HH:MM UTC.
function msUntilUtc(hhmm, now = new Date()) {
  const [hours, minutes] = hhmm.split(':').map(Number);
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}

// Runs the ingest daily at CLAIMS_INGEST_TIME_UTC (default 06:00, before
// YT-Validator's 08:15 collector). Off unless CLAIMS_INGEST_ENABLED is set.
function startClaimsIngestScheduler() {
  if (!['true', '1'].includes(process.env.CLAIMS_INGEST_ENABLED)) {
    console.log('Daily claims ingest disabled: CLAIMS_INGEST_ENABLED not set');
    return;
  }

  const time = process.env.CLAIMS_INGEST_TIME_UTC || '06:00';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error(`CLAIMS_INGEST_TIME_UTC must be HH:MM, got "${time}"`);
  }

  const scheduleNext = () => {
    const delay = msUntilUtc(time);
    console.log(`Next daily claims ingest at ${new Date(Date.now() + delay).toISOString()}`);
    setTimeout(async () => {
      try {
        await runClaimsIngest({ trigger: 'schedule' });
      } catch (error) {
        console.error('Daily claims ingest crashed:', error);
      }
      scheduleNext();
    }, delay);
  };
  scheduleNext();
}

module.exports = {
  COLLECTION,
  isAuthError,
  runClaimsIngest,
  isClaimsIngestRunning,
  startClaimsIngestScheduler,
  msUntilUtc,
  removeReportDownloads,
  describeFailure
};
