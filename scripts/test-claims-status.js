#!/usr/bin/env node

/*
Offline checks for the per-owner snapshots in the claims ingest status: no
Mongo, no YouTube, no network.

  node scripts/test-claims-status.js
*/

const assert = require('assert');

const { ownerSnapshots } = require('../src/controllers/claimsIngestController');

// Just enough of the driver: findOne with a filter on status and on
// `reports.<source>` existing, newest startedAt first.
function fakeCollection(docs) {
  return {
    findOne: async (filter, { sort } = {}) => {
      const [path] = Object.keys(filter).filter(key => key.startsWith('reports.'));
      const source = path.split('.')[1];
      const matches = docs
        .filter(d => d.status === filter.status && d.reports?.[source])
        .sort((a, b) => (sort?.startedAt === -1 ? b.startedAt - a.startedAt : a.startedAt - b.startedAt));
      return matches[0] || null;
    },
  };
}

// The two real ingests of 2026-09-16: the 06:00 run only fetched Matter 2,
// because Matter Entertainment's newest report was already ingested at 01:53.
const manual = {
  _id: { toString: () => '6aa9f6a0df9ae860c98e0204' },
  status: 'completed',
  startedAt: new Date('2026-09-16T01:53:36Z'),
  endedAt: new Date('2026-09-16T02:03:17Z'),
  reports: {
    matter_entertainment: { startTime: '2026-09-10T07:00:00Z', createTime: '2026-09-12T21:11:45Z' },
    matter_2: { startTime: '2026-09-10T07:00:00Z', createTime: '2026-09-12T20:31:07Z' },
  },
  results: { claimsProcessed: {
    matter_entertainment: { total: 475234, new: 1533 },
    matter_2: { total: 212845, new: 521 },
  } },
};
const scheduled = {
  _id: { toString: () => '6aaa3060d219fb53d27974d7' },
  status: 'completed',
  startedAt: new Date('2026-09-16T06:00:00Z'),
  endedAt: new Date('2026-09-16T06:04:11Z'),
  reports: { matter_2: { startTime: '2026-09-14T07:00:00Z', createTime: '2026-09-16T05:28:09Z' } },
  results: { claimsProcessed: { matter_2: { total: 212938, new: 120 } } },
};

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const bySource = owners => Object.fromEntries(owners.map(o => [o.source, o]));


test('an owner absent from the latest run keeps its own latest snapshot', async () => {
  const owners = bySource(await ownerSnapshots(fakeCollection([manual, scheduled])));

  assert.deepStrictEqual(owners.matter_2, {
    source: 'matter_2',
    snapshot: '2026-09-14',
    publishedAt: '2026-09-16T05:28:09Z',
    ingestedAt: scheduled.endedAt,
    new: 120,
    total: 212938,
    ingestId: '6aaa3060d219fb53d27974d7',
  });
  // the case that vanished from the console: read from the 01:53 run instead
  assert.strictEqual(owners.matter_entertainment.snapshot, '2026-09-10');
  assert.strictEqual(owners.matter_entertainment.new, 1533);
  assert.strictEqual(owners.matter_entertainment.ingestId, '6aa9f6a0df9ae860c98e0204');
});

test('failed and skipped attempts are not snapshots', async () => {
  const failed = {
    ...scheduled,
    _id: { toString: () => 'failed' },
    status: 'failed',
    startedAt: new Date('2026-09-17T06:00:00Z'),
    reports: { matter_2: { startTime: '2026-09-15T07:00:00Z' } },
  };
  const owners = bySource(await ownerSnapshots(fakeCollection([manual, scheduled, failed])));
  assert.strictEqual(owners.matter_2.snapshot, '2026-09-14');
});

test('every configured owner is listed, even one never ingested', async () => {
  const owners = await ownerSnapshots(fakeCollection([scheduled]));
  assert.deepStrictEqual(owners.map(o => o.source), ['matter_entertainment', 'matter_2']);

  const never = bySource(owners).matter_entertainment;
  assert.deepStrictEqual(never, {
    source: 'matter_entertainment',
    snapshot: null,
    publishedAt: null,
    ingestedAt: null,
    new: null,
    total: null,
    ingestId: null,
  });
});


(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (error) {
      failed++;
      console.error(`✗ ${name}\n  ${error.message}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
