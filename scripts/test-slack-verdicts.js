#!/usr/bin/env node

/*
Offline checks for what the Slack bot says about claims. No Slack, no Mongo,
no pipeline run.

  node scripts/test-slack-verdicts.js
*/

const assert = require('assert');

const database = require('../src/database');
let lastIngest = null;
database.getDatabase = () => ({
  collection: () => ({ findOne: async () => lastIngest })
});

const { claimsSourceLine } = require('../src/controllers/slackController');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);


test('with nothing staged it names the daily ingest and its snapshot', async () => {
  lastIngest = { reports: {
    matter_entertainment: { startTime: '2026-10-09T07:00:00Z' },
    matter_2: { startTime: '2026-10-11T07:00:00Z' }
  } };
  const line = await claimsSourceLine(null);
  assert.match(line, /already collected daily/);
  assert.match(line, /2026-10-11/);        // the newest of the two owners
  assert.doesNotMatch(line, /staged/);
});

test('staged files win, and say who put them there', async () => {
  const line = await claimsSourceLine({
    uploadedBy: 'edouard',
    uploadedAt: '2026-10-02T19:00:00Z',
    claims: { matter_entertainment: 'a.csv', matter_2: 'b.csv' }
  });
  assert.match(line, /staged by edouard/);
  assert.match(line, /Matter Entertainment, Matter 2/);
  assert.doesNotMatch(line, /collected daily/);
});

test('it still answers when no ingest has ever completed', async () => {
  lastIngest = null;
  assert.strictEqual(await claimsSourceLine(null), '📋 *Claims:* already collected daily');
});

test('a database failure does not stop the run being announced', async () => {
  database.getDatabase = () => { throw new Error('no mongo'); };
  assert.match(await claimsSourceLine(null), /already collected daily/);
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
