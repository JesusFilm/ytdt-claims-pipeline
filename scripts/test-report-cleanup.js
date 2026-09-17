#!/usr/bin/env node

/*
Offline checks for removing claims report downloads after a successful ingest.
Works in a throwaway directory: no Mongo, no YouTube, no network.

  node scripts/test-report-cleanup.js
*/

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { removeReportDownloads } = require('../src/jobs/claimsIngest');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function scratch(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reports-'));
  for (const name of files) fs.writeFileSync(path.join(dir, name), 'x');
  return dir;
}
const left = dir => fs.readdirSync(dir).sort();


test("a failed run's downloads are removed by the next successful run", async () => {
  const dir = scratch([
    'matter_2_2026-09-14_17608817954.csv',            // this run
    'matter_entertainment_2026-09-10_20434750253.csv', // left by an earlier failed run
  ]);
  const removed = await removeReportDownloads(dir);
  assert.strictEqual(removed.length, 2);
  assert.deepStrictEqual(left(dir), []);
});

test('only report downloads are removed', async () => {
  const keep = [
    'notes.txt',
    'matter_2_2026-09-14_17608817954.csv.bak',
    'other_owner_2026-09-14_1.csv',     // not a configured owner
    'matter_2_20260914_17608817954.csv', // wrong date shape
    'matter_2_2026-09-14_abc.csv',       // report ids are numeric
  ];
  const dir = scratch([...keep, 'matter_2_2026-09-14_1.csv']);
  fs.mkdirSync(path.join(dir, 'matter_2_2026-09-14_2.csv')); // a directory with a report-like name
  await removeReportDownloads(dir);
  assert.deepStrictEqual(left(dir), [...keep, 'matter_2_2026-09-14_2.csv'].sort());
});

test('a symlink with a report name is not followed or removed', async () => {
  const target = scratch(['precious.csv']);
  const dir = scratch([]);
  fs.symlinkSync(path.join(target, 'precious.csv'), path.join(dir, 'matter_2_2026-09-14_1.csv'));
  await removeReportDownloads(dir);
  assert.deepStrictEqual(left(target), ['precious.csv']);
  assert.deepStrictEqual(left(dir), ['matter_2_2026-09-14_1.csv']);
});

test('a missing directory is not an error', async () => {
  const removed = await removeReportDownloads(path.join(os.tmpdir(), 'no-such-reports-dir-' + Date.now()));
  assert.deepStrictEqual(removed, []);
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
