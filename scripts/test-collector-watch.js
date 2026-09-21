#!/usr/bin/env node

/*
Offline checks for the ASR collector watcher: no YT-Validator, no Slack, no network.

  node scripts/test-collector-watch.js
*/

const assert = require('assert');

const { assessCollector } = require('../src/jobs/collectorWatch');

const NOW = new Date('2026-09-21T08:45:00Z');
// A healthy run as /asr/status reports it, timestamps naive and UTC
const healthy = {
  cache: { videos: 182, with_track: 166, no_track: 16 },
  collector: {
    last_run: '2026-09-21T08:16:10',
    looked_up: 180, added: 180, failed: 0,
    remaining: 4341, queue_videos_needing_asr: 4523,
    stopped_reason: null, stopped_detail: ''
  },
  queue: { rows: 4549, written_at: '2026-09-21T06:03:22+00:00' }
};
const withRun = extra => ({ ...healthy, collector: { ...healthy.collector, ...extra } });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);


test('a healthy run says nothing', () => {
  assert.strictEqual(assessCollector(healthy, NOW), null);
});

test('a run that stopped names the reason and the API detail', () => {
  const p = assessCollector(withRun({ stopped_reason: 'quota', stopped_detail: 'quotaExceeded', added: 97, looked_up: 180 }), NOW);
  assert.match(p.lead, /ASR collector stopped.*quota exhausted \(quotaExceeded\)/);
  assert.match(p.body, /97 of 180 lookups cached/);
  assert.match(p.body, /4,341 videos still to collect/);
  assert.match(p.body, /next run is 08:15 UTC tomorrow/);
});

test('an unfamiliar stop reason is still reported, verbatim', () => {
  const p = assessCollector(withRun({ stopped_reason: 'something_new' }), NOW);
  assert.match(p.lead, /something_new/);
});

test('lookups that cached nothing are the quiet failure, and alert', () => {
  // the shape that has no stopped_reason and would otherwise pass for healthy
  const p = assessCollector(withRun({ looked_up: 180, added: 0 }), NOW);
  assert.match(p.lead, /answered nothing/);
  assert.match(p.body, /180 lookups came back empty/);
});

test('a run that looked nothing up is not a failure', () => {
  // nothing left to collect: looked_up 0, added 0
  assert.strictEqual(assessCollector(withRun({ looked_up: 0, added: 0, remaining: 0 }), NOW), null);
});

test('a run older than the staleness window means it did not happen', () => {
  const p = assessCollector(withRun({ last_run: '2026-09-20T06:10:00' }), NOW);
  assert.match(p.lead, /has not run/);
  assert.match(p.body, /26h ago/);
  assert.match(p.body, /asr_queue\.csv/);
});

test('a run just inside the window is fine', () => {
  // 25h59m: a late run, not a missed day
  assert.strictEqual(assessCollector(withRun({ last_run: '2026-09-20T06:46:00' }), NOW), null);
});

test('a naive timestamp is read as UTC, not local time', () => {
  // 08:16 UTC today: only stale if misread as local time in a zone behind UTC
  assert.strictEqual(assessCollector(healthy, NOW), null);
  const p = assessCollector(withRun({ last_run: '2026-09-21T08:16:10+00:00' }), NOW);
  assert.strictEqual(p, null, 'an explicit offset must be honoured too');
});

test('a collector that has never run is reported', () => {
  const p = assessCollector({ collector: {}, queue: {} }, NOW);
  assert.match(p.lead, /has not run/);
  assert.match(p.body, /never recorded a run/);
});

test('an unreachable status is its own alert', () => {
  // YT-Validator down: we cannot see last_run at all, so staleness can never fire
  const p = assessCollector(null, NOW);
  assert.match(p.lead, /status unreachable/);
  assert.match(p.body, /claims still arrive as usual/);
});

test('stopped takes precedence over the empty-lookup shape', () => {
  const p = assessCollector(withRun({ stopped_reason: 'outage', stopped_detail: 'ECONNRESET', looked_up: 12, added: 0 }), NOW);
  assert.match(p.lead, /YouTube unreachable \(ECONNRESET\)/);
});


let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`✗ ${name}\n  ${error.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
