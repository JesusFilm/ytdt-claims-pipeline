#!/usr/bin/env node

/*
Offline checks for telling uploaded CSVs apart. No Slack, no Mongo, no network.

  node scripts/test-verdict-files.js
*/

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { classifyCsv, classifyVerdicts, ownedVideoIds, readVideoIds } = require('../src/lib/verdictFiles');

const VERDICT_HEADER = 'video_id,verdict,no_code,wave,media_component_id,language_id,is_edited';
const CLAIMS_HEADER = 'claim_id,claim_status,asset_id,video_id,video_title,views,asset_labels';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdicts-'));
const write = (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };

const tests = [];
const test = (name, fn) => tests.push([name, fn]);


test('a verdicts file is recognised however its header is spelled', () => {
  assert.strictEqual(classifyCsv(VERDICT_HEADER), 'verdicts');
  // Ben's real files: a trailing space, a hyphen, and 40 empty trailing columns
  assert.strictEqual(classifyCsv('video_id,verdict ,no-code,Wave,media_component_id,language_id,is_edited,,,,,'), 'verdicts');
  assert.strictEqual(classifyCsv('﻿video_id,verdict,no_code,wave,media_component_id,language_id,is_edited'), 'verdicts');
});

test('a claims file is not mistaken for verdicts, whatever it is called', () => {
  // "All_NO_Claims_MCN_..." is a verdicts file; names prove nothing either way
  assert.strictEqual(classifyCsv(CLAIMS_HEADER), 'claims');
  assert.strictEqual(classifyCsv('foo,bar'), 'unknown');
});

test('MCN and JFM are separated by whose videos they are', () => {
  const owned = new Set(['own1', 'own2', 'own3', 'own4']);
  assert.strictEqual(classifyVerdicts(['own1', 'own2', 'own3'], owned).kind, 'jfm');
  assert.strictEqual(classifyVerdicts(['other1', 'other2', 'other3'], owned).kind, 'mcn');
  // a 50/50 mix is not guessed at — it goes back to the person
  assert.strictEqual(classifyVerdicts(['own1', 'own2', 'x', 'y'], owned).kind, 'unsure');
});

test('without an owned-videos export it says so instead of guessing', () => {
  const r = classifyVerdicts(['a', 'b'], null);
  assert.strictEqual(r.kind, 'unsure');
  assert.match(r.reason, /owned-videos/);
});

test('owned ids survive commas inside video descriptions', () => {
  // splitting on commas shifted every column and matched nothing
  const exports_ = path.join(dir, 'exports', 'run1');
  fs.mkdirSync(exports_, { recursive: true });
  fs.writeFileSync(path.join(exports_, 'owned_videos.csv'),
    'channel_id,channel_title,description,video_id\n' +
    'UC1,Jesus Film,"God has allowed us, at last, to finish",vid_one\n' +
    'UC1,Jesus Film,"Plain description",vid_two\n');
  const ids = ownedVideoIds(path.join(dir, 'exports'));
  assert.deepStrictEqual([...ids].sort(), ['vid_one', 'vid_two']);
});

test('every row is counted, not just the classification sample', () => {
  // the count goes in front of the person pressing Run, so it must be the real one
  const rows = Array.from({ length: 6000 }, (_, i) => `vid${i},N,,262,,529,0`).join('\n');
  const p = write('big.csv', `${VERDICT_HEADER}\n${rows}\n`);
  assert.strictEqual(readVideoIds(p).length, 6000);
  // and the classifier still samples rather than reading all of them
  assert.strictEqual(classifyVerdicts(readVideoIds(p), new Set(['vid0'])).sampled, 200);
});

test('video ids are read from a quoted verdicts file', () => {
  const p = write('v.csv', `${VERDICT_HEADER}\nabc123,N,"code, with comma",262,1_jf,529,0\ndef456,Y,,262,,529,0\n`);
  assert.deepStrictEqual(readVideoIds(p), ['abc123', 'def456']);
});


let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (error) { failed++; console.error(`✗ ${name}\n  ${error.message}`); }
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
