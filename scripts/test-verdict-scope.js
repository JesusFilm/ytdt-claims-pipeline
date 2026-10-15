#!/usr/bin/env node

/*
Offline checks for which rows the invalid-id counts cover. No MySQL: a fake
connection records the SQL and answers with rows.

  node scripts/test-verdict-scope.js
*/

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src/steps/process-verdicts.js'), 'utf8');
const processVerdicts = require('../src/steps/process-verdicts');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);


test('invalid ids are looked for in the uploaded file, not the whole table', () => {
  // the counts go to whoever sent the file, so they must be about that file
  const mcid = source.slice(source.indexOf('const [invalidMCIDs]'), source.indexOf('const [invalidLanguageIDs]'));
  assert.match(mcid, /FROM \$\{tableName\} v/, 'reads the staging table of this upload');
  assert.doesNotMatch(mcid, /FROM \$\{targetTable\} v\s*\n\s*WHERE CONVERT\(v\.media_component_id/,
    'no longer scans every claim ever loaded');

  const lang = source.slice(source.indexOf('const [invalidLanguageIDs]'), source.indexOf('const [[allClaims]]'));
  assert.match(lang, /FROM \$\{tableName\} v/);
});

test('the language check uses the column the view actually has', () => {
  // process_verdicts.sql in jfp_yt_dw compares against "language_id", which
  // bi_view_media_language does not expose: MySQL resolves it to the outer
  // column and the check silently passes for every row
  const lang = source.slice(source.indexOf('const [invalidLanguageIDs]'), source.indexOf('const [[allClaims]]'));
  assert.match(lang, /wess_language_id/);
  assert.doesNotMatch(lang, /SELECT CONVERT\(language_id USING/);
});

test('the all-time figures are kept, as counts rather than rows', () => {
  assert.match(source, /acrossAllClaims/);
  const all = source.slice(source.indexOf('const [[allClaims]]'), source.indexOf('context.outputs'));
  assert.match(all, /COUNT\(\*\)/);
  assert.match(all, /FROM \$\{targetTable\}/, 'still asks the whole-table question');
});

test('blank and placeholder ids are not reported as invalid', () => {
  const body = source.slice(source.indexOf('const [invalidMCIDs]'), source.indexOf('context.outputs'));
  for (const clause of ["!= '-'", "!= ''", 'IS NOT NULL']) {
    assert.ok(body.includes(clause), `missing ${clause}`);
  }
});

test('ignored MCID patterns still apply, to both scopes', () => {
  const body = source.slice(source.indexOf('const ignoredMCIDs'), source.indexOf('context.outputs'));
  assert.strictEqual((body.match(/\$\{ignoredMCIDs\}/g) || []).length, 2);
});


// Run it for real against a fake connection, so the assertions are about the
// SQL that executes rather than the text of the file.
test('the queries it actually runs are scoped to the upload', async () => {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdicts-'));
  const file = path.join(dir, 'mcn.csv');
  fs.writeFileSync(file,
    'video_id,verdict,media_component_id,language_id,wave,no_code,is_edited\n' +
    'abc123,Y,1_jf-0-0,529,262,,0\n');

  const statements = [];
  const mysql = {
    escape: value => (value === null || value === undefined ? 'NULL' : `'${String(value)}'`),
    query: async sql => {
      statements.push(String(sql).replace(/\s+/g, ' ').trim());
      if (/SELECT\s*\(SELECT COUNT/i.test(sql)) return [[{ invalidMCIDs: 1247, invalidLanguageIDs: 10106 }]];
      return [[]];
    }
  };
  const context = { files: { mcnVerdicts: file }, connections: { mysql }, outputs: {} };
  await processVerdicts(context);
  fs.rmSync(dir, { recursive: true, force: true });

  const selects = statements.filter(s => s.startsWith('SELECT'));
  const perFile = selects.filter(s => /FROM mcn_verdicts_\d{8} v/.test(s));
  assert.strictEqual(perFile.length, 2, 'both id checks read this upload\'s table');
  assert.ok(perFile.every(s => /LEFT JOIN youtube_mcn_claims c/.test(s)),
    'joined only to fetch channel and views for the report');

  const allTime = selects.find(s => /SELECT \(SELECT COUNT/.test(s));
  assert.ok(allTime && /FROM youtube_mcn_claims v/.test(allTime));

  assert.deepStrictEqual(context.outputs.mcnVerdicts.acrossAllClaims,
    { invalidMCIDs: 1247, invalidLanguageIDs: 10106 });
  assert.strictEqual(context.outputs.mcnVerdicts.processed, 1);
});


test('bad ids are grouped, worst first, with examples to look at', async () => {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdicts-'));
  const file = path.join(dir, 'mcn.csv');
  fs.writeFileSync(file,
    'video_id,verdict,media_component_id,language_id,wave,no_code,is_edited\n' +
    'abc123,Y,1_jf-0-0,529,262,,0\n');

  // three rows share one bad id, one row has another: 2 ids, 4 rows
  const badMCIDs = [
    { video_id: 'v1', media_component_id: '1_jf61??-0-0' },
    { video_id: 'v2', media_component_id: '1_jf61??-0-0' },
    { video_id: 'v3', media_component_id: '1_jf61??-0-0' },
    { video_id: 'v4', media_component_id: 'MC005' },
  ];
  let select = 0;
  const mysql = {
    escape: v => `'${v}'`,
    query: async sql => {
      if (!String(sql).trim().startsWith('SELECT')) return [[]];
      select += 1;
      if (/SELECT\s*\(SELECT COUNT/i.test(sql)) return [[{ invalidMCIDs: 1247, invalidLanguageIDs: 10106 }]];
      return [select === 1 ? badMCIDs : []];
    }
  };
  const context = { files: { mcnVerdicts: file }, connections: { mysql }, outputs: {} };
  await processVerdicts(context);
  fs.rmSync(dir, { recursive: true, force: true });

  const { mcids, languages } = context.outputs.mcnVerdicts.invalidSummary;
  assert.strictEqual(mcids.distinct, 2, 'two ids to fix');
  assert.strictEqual(mcids.rows, 4, 'four rows affected');
  assert.strictEqual(mcids.byId[0].id, '1_jf61??-0-0', 'worst first');
  assert.strictEqual(mcids.byId[0].rows, 3);
  assert.deepStrictEqual(mcids.byId[0].examples, ['v1', 'v2', 'v3']);
  assert.deepStrictEqual(languages, { distinct: 0, rows: 0, byId: [] });

  // the raw rows stay available for the download
  assert.strictEqual(context.outputs.mcnVerdicts.invalidMCIDs.length, 4);
});

test('the Slack line says ids and rows, not one number', () => {
  const notifier = fs.readFileSync(path.join(__dirname, '..', 'src/lib/slackNotifier.js'), 'utf8');
  assert.match(notifier, /across \$\{s\.rows/);
  assert.match(notifier, /invalidSummary/);
});


let failed = 0;
(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`✓ ${name}`); }
    catch (error) { failed++; console.error(`✗ ${name}\n  ${error.message}`); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
