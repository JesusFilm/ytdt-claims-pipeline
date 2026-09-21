const { fetchCollectorStatus } = require('../controllers/claimsIngestController');
const { raiseAlert, clearAlert } = require('../lib/serviceAlerts');
const { msUntilUtc } = require('./claimsIngest');

/**
 * Watches YT-Validator's ASR collector, which cannot watch itself.
 *
 * Its systemd unit carries ConditionPathExists on the queue file, so a missing
 * queue means the timer fires, the unit is skipped, and no Python runs — there
 * is no process left to notice, let alone report. The same goes for the service
 * being dead or the VM being down. Only something outside it can say so, and
 * this service already reads /asr/status to proxy the collector block to the
 * console, so it is holding the answer either way.
 *
 * Deliberately not covered: this service failing. Nothing here can report that;
 * it needs an uptime check outside both services.
 */

const ALERT = 'asr-collector';
const WATCH_TIME_UTC = process.env.COLLECTOR_WATCH_TIME_UTC || '08:45';
// yt-validator-asr-collect.timer on the VM; quoted in the alert so the reader
// knows when to expect it to right itself.
const COLLECTOR_RUN_TIME_UTC = process.env.COLLECTOR_RUN_TIME_UTC || '08:15';
// 26h leaves room for a late run without letting a skipped day pass unnoticed.
const STALE_AFTER_HOURS = parseInt(process.env.COLLECTOR_STALE_HOURS) || 26;

const STOPPED_LABELS = { quota: 'quota exhausted', outage: 'YouTube unreachable' };

// Timestamps arrive without an offset and are UTC; read as local time they can
// look a day out, which here decides whether we alert at all.
function parseUtc(value) {
  if (!value) return null;
  const naive = value.includes('T') && !/(Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const date = new Date(naive ? `${value}Z` : value);
  return isNaN(date.getTime()) ? null : date;
}

function hoursSince(value, now) {
  const date = parseUtc(value);
  return date ? (now - date) / 3600000 : null;
}

/**
 * What to say about the collector, or null when it is healthy.
 * `status` is the /asr/status body, or null when it could not be fetched.
 */
function assessCollector(status, now = new Date()) {
  if (!status) {
    return {
      lead: ':mag: *ASR collector status unreachable*',
      body: 'YT-Validator did not answer /asr/status, so whether the collector ran is unknown. ' +
        'Check the yt-validator service on the VM. Audio languages stop being collected while it is down, ' +
        'and claims still arrive as usual.'
    };
  }

  const run = status.collector || {};
  const queue = status.queue || {};
  const remaining = run.remaining ?? queue.rows;
  const age = hoursSince(run.last_run, now);

  if (!run.last_run || (age !== null && age > STALE_AFTER_HOURS)) {
    const when = run.last_run ? `Its last run was ${Math.floor(age)}h ago.` : 'It has never recorded a run.';
    return {
      lead: ':mag: *ASR collector has not run*',
      body: `${when} The ${COLLECTOR_RUN_TIME_UTC} UTC run did not happen: its timer is skipped when data/asr_queue.csv is ` +
        'missing, so check that file and the yt-validator service on the VM. No audio languages are being ' +
        'collected until it runs again.'
    };
  }

  if (run.stopped_reason) {
    const label = STOPPED_LABELS[run.stopped_reason] || run.stopped_reason;
    const detail = run.stopped_detail ? ` (${run.stopped_detail})` : '';
    return {
      lead: `:mag: *ASR collector stopped* — ${label}${detail}`,
      body: `${(run.added ?? 0).toLocaleString()} of ${(run.looked_up ?? 0).toLocaleString()} lookups cached, ` +
        `${(remaining ?? 0).toLocaleString()} videos still to collect. No audio languages accumulate until ` +
        `this clears; the next run is ${COLLECTOR_RUN_TIME_UTC} UTC tomorrow.`
    };
  }

  // The quiet shape of the same failure: it asked YouTube and kept nothing, with
  // nothing classified as a stop. This is how a silent outage looks from outside.
  if ((run.looked_up ?? 0) > 0 && (run.added ?? 0) === 0) {
    return {
      lead: ':mag: *ASR collector answered nothing*',
      body: `Every one of its ${run.looked_up.toLocaleString()} lookups came back empty and nothing was ` +
        `cached, with no reason recorded. ${(remaining ?? 0).toLocaleString()} videos still to collect. ` +
        'Check the yt-validator journal on the VM for the API error.'
    };
  }

  return null;
}

// Alerts once per outage and clears when the collector is healthy again.
async function checkCollector(now = new Date()) {
  const { value } = await fetchCollectorStatus();
  const problem = assessCollector(value, now);
  if (!problem) {
    await clearAlert(ALERT);
    return null;
  }
  await raiseAlert(ALERT, `${problem.lead}\n${problem.body}`);
  return problem;
}

// Runs daily at COLLECTOR_WATCH_TIME_UTC (default 08:45, half an hour after the
// collector's own 08:15 run, so it reads that run rather than yesterday's).
function startCollectorWatchScheduler() {
  if (!process.env.ML_API_ENDPOINT) {
    console.log('Collector watch disabled: ML_API_ENDPOINT not set');
    return;
  }

  const schedule = () => {
    const wait = msUntilUtc(WATCH_TIME_UTC);
    console.log(`Next collector check at ${new Date(Date.now() + wait).toISOString()}`);
    setTimeout(async () => {
      try {
        const problem = await checkCollector();
        console.log(problem ? `collector check: ${problem.lead}` : 'collector check: healthy');
      } catch (error) {
        // Never let the watcher's own failure stop it watching tomorrow
        console.error('collector check failed:', error.message);
      }
      schedule();
    }, wait);
  };
  schedule();
}

module.exports = { assessCollector, checkCollector, startCollectorWatchScheduler, ALERT };
