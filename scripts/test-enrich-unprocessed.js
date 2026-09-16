#!/usr/bin/env node

/*
Offline checks for enrichUnprocessedClaims: no MySQL, no YouTube, no network.
Uses throwaway reference CSVs, so data/ is never read.

  node scripts/test-enrich-unprocessed.js
*/

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The module reads these paths when it loads, so set them first
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-'));
process.env.LICENSED_CSV = path.join(dir, 'Licensed.csv');
process.env.ASSETS_MEDIA_CSV = path.join(dir, 'assets_single_media_component.csv');
// the BOM the real Licensed.csv carries, so that fix stays covered too
fs.writeFileSync(process.env.LICENSED_CSV, '﻿asset_id\nA_LICENSED\n');
fs.writeFileSync(process.env.ASSETS_MEDIA_CSV, 'asset_id,media_component_id\nA_SINGLE,1_jf-0-0\n');

const enrich = require('../src/lib/enrichUnprocessedClaims');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);


test('a media_component_id the view already has is kept', async () => {
  // asset not in the single-component CSV: this used to come out blank
  const rows = [{ asset_id: 'A_OTHER', video_id: 'v1', media_component_id: '2_0-Acts' }];
  await enrich(rows, { skipAvailability: true });
  assert.strictEqual(rows[0].media_component_id, '2_0-Acts');
});

test('the view keeps its value even when the CSV maps the asset differently', async () => {
  const rows = [{ asset_id: 'A_SINGLE', video_id: 'v1', media_component_id: '1_jf6101-0-0' }];
  await enrich(rows, { skipAvailability: true });
  assert.strictEqual(rows[0].media_component_id, '1_jf6101-0-0');
});

test('a blank or NULL media_component_id is filled from the CSV', async () => {
  const rows = [
    { asset_id: 'A_SINGLE', video_id: 'v1', media_component_id: '' },
    { asset_id: 'A_SINGLE', video_id: 'v2', media_component_id: null },
    { asset_id: 'A_SINGLE', video_id: 'v3' },
  ];
  await enrich(rows, { skipAvailability: true });
  assert.deepStrictEqual(rows.map(r => r.media_component_id), ['1_jf-0-0', '1_jf-0-0', '1_jf-0-0']);
});

test('blank with no mapping stays an empty string, not null', async () => {
  const rows = [{ asset_id: 'A_OTHER', video_id: 'v1', media_component_id: null }];
  await enrich(rows, { skipAvailability: true });
  assert.strictEqual(rows[0].media_component_id, '');
});

test('licensed still reads Licensed.csv past its BOM', async () => {
  const rows = [{ asset_id: 'A_LICENSED', video_id: 'v1' }, { asset_id: 'A_OTHER', video_id: 'v2' }];
  await enrich(rows, { skipAvailability: true });
  assert.deepStrictEqual(rows.map(r => r.licensed), ['True', 'False']);
  assert.ok(!('video_available' in rows[0]), 'skipAvailability omits the column');
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
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
