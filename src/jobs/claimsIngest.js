const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const { getDatabase } = require('../database');
const { getCurrentPipelineStatus } = require('../pipeline');
const { createAuthedClient } = require('../lib/authtedClient');
const { generateRunFolderName } = require('../lib/utils');
const youtubeReporting = require('../lib/youtubeReporting');

const { notifyClaimsIngestAuthRequired } = require('../lib/slackNotifier');

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

let running = false;


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

// Failures only a person can fix, by signing in again with scripts/youtube-reporting-auth.js:
// the refresh token expired or was revoked, or the account lost access to the content owner.
function isAuthError(error) {
  const reason = error.response?.data?.error;
  const status = error.response?.status;
  return ['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(reason) ||
    status === 401 || status === 403 ||
    (error.code === 'ENOENT' && error.path === process.env.YT_REPORTING_TOKEN_FILE) ||
    /invalid_grant|YT_REPORTING_TOKEN_FILE|YouTube Reporting credentials/.test(error.message);
}

// One alert per outage, not one per daily retry.
async function alertAuthRequired(collection, recordId, record) {
  const previous = await collection.findOne(
    { _id: { $ne: recordId }, status: { $nin: ['skipped', 'running'] } },
    { sort: { startedAt: -1 } }
  );
  if (previous?.authRequired) return;
  try {
    await notifyClaimsIngestAuthRequired(record.error);
  } catch (err) {
    console.error('claims ingest: auth alert failed:', err.message);
  }
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
  const downloaded = [];
  let recordId = null;
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
      downloaded.push(dest);
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
      enrichUnprocessed: false,
      exportDir: path.join(process.cwd(), 'data', 'exports', 'claims-ingest', generateRunFolderName(context.startTime))
    };
    await exportViews(context);

    const unprocessed = context.outputs.exports?.export_unprocessed_claims;
    record.results.asrQueue = unprocessed
      ? { rows: unprocessed.rows, path: unprocessed.path, response: await postAsrQueue(unprocessed.path) }
      : { skipped: 'no unprocessed claims exported' };

    record.status = 'completed';
    return record;

  } catch (error) {
    record.status = 'failed';
    record.error = error.message;
    if (stage === 'reporting' && isAuthError(error)) {
      record.authRequired = true;
      record.error = `YouTube rejected the stored sign-in (${error.message}). Re-authorize: ` +
        'node scripts/youtube-reporting-auth.js <desktop-client.json> "$YT_REPORTING_TOKEN_FILE"';
    }
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
      for (const file of downloaded) await fs.promises.rm(file, { force: true });
    }

    record.endedAt = new Date();
    if (recordId) {
      await collection.updateOne({ _id: recordId }, { $set: record });
      if (record.authRequired) await alertAuthRequired(collection, recordId, record);
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
  msUntilUtc
};
