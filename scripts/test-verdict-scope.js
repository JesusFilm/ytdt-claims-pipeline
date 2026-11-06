#!/usr/bin/env node

/*
Offline checks for which rows the invalid-id counts cover. No warehouse: a fake
BigQuery client records the SQL and answers with rows.

  node scripts/test-verdict-scope.js
*/

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bigqueryPath = require.resolve('../src/lib/bigquery');
const { escapeValue } = require(bigqueryPath);

const source = fs.readFileSync(path.join(__dirname, '..', 'src/steps/process-verdicts.js'), 'utf8');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// Stand in for src/lib/bigquery so process-verdicts runs without a warehouse.
// `answer` is called with each SELECT's position (1-based) and returns its rows.
function fakeBigQuery(statements, answer = () => []) {
  const record = (query) => {
    const sql = String(query).replace(/\s+/g, ' ').trim();
    statements.push(sql);
    return sql;
  };
  let selects = 0;
  const run = (query) => {
    const sql = record(query);
    if (!sql.startsWith('SELECT')) return [[]];
    selects += 1;
    return [answer(selects)];
  };

  const client = {
    query: async ({ query }) => run(query),
    createQueryJob: async ({ query }) => {
      record(query);
      return [{
        getQueryResults: async () => [[]],
        getMetadata: async () => [{ statistics: { query: { dmlStats: { updatedRowCount: 1 } } } }]
      }];
    }
  };

  const table = () => ({
    exists: async () => [true],
    getMetadata: async () => [{
      schema: {
        fields: [
          { name: 'video_id', type: 'STRING' },
          { name: 'verdict', type: 'STRING' },
          { name: 'media_component_id', type: 'STRING' },
          { name: 'language_id', type: 'STRING' },
          { name: 'wave', type: 'STRING' },
          { name: 'no_code', type: 'STRING' },
          { name: 'is_edited', type: 'INT64' },
          { name: 'channel_id', type: 'STRING' },
          { name: 'views', type: 'INT64' }
        ]
      }
    }]
  });

  require.cache[bigqueryPath] = {
    id: bigqueryPath, filename: bigqueryPath, loaded: true, exports: {
      getBigQueryClient: () => client,
      getDataset: () => ({ createTable: async () => [table()], table }),
      getTable: table,
      tableRef: (name) => `\`jfp-data-warehouse.youtube.${name}\``,
      coreTableRef: (name) => `\`jfp-data-warehouse.core_analytics_views.${name}\``,
      escapeValue
    }
  };

  delete require.cache[require.resolve('../src/steps/process-verdicts')];
  return require('../src/steps/process-verdicts');
}

// One verdict row, the shape the console and Slack upload.
function stageVerdictFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdicts-'));
  const file = path.join(dir, 'mcn.csv');
  fs.writeFileSync(file,
    'video_id,verdict,media_component_id,language_id,wave,no_code,is_edited\n' +
    'abc123,Y,1_jf-0-0,529,262,,0\n');
  return { dir, file };
}


test('invalid ids are looked for in the uploaded file, not the whole table', () => {
  // the counts go to whoever sent the file, so they must be about that file
  const mcid = source.slice(source.indexOf('const [invalidMCIDs]'), source.indexOf('const [invalidLanguageIDs]'));
  assert.match(mcid, /FROM \$\{tableRef\(tableName\)\} v/, 'reads the staging table of this upload');
  assert.doesNotMatch(mcid, /FROM \$\{tableRef\(targetTable\)\} v/, 'no longer scans every claim ever loaded');

  const lang = source.slice(source.indexOf('const [invalidLanguageIDs]'), source.indexOf('const backlog ='));
  assert.match(lang, /FROM \$\{tableRef\(tableName\)\} v/);
});

test('the language check uses the column the view actually has', () => {
  // bi_view_media_language exposes wess_language_id and nothing shorter.
  // Comparing against "language_id", as the warehouse's own
  // process_verdicts.sql does, resolves to the outer column and the check
  // silently passes for every row.
  const lang = source.slice(source.indexOf('const [invalidLanguageIDs]'), source.indexOf('const backlog ='));
  assert.match(lang, /wess_language_id/);
  assert.doesNotMatch(lang, /SELECT language_id FROM/);
});

test('the whole-table backlog is listed, not just counted', () => {
  assert.match(source, /acrossAllClaims/);
  const backlog = source.slice(source.indexOf('async function writeBacklog'), source.indexOf('// Group bad rows'));
  assert.strictEqual((backlog.match(/FROM \$\{tableRef\(targetTable\)\} v/g) || []).length, 2,
    'still asks the whole-table question, for both ids');
  assert.match(backlog, /invalid-mcids-all-claims-\$\{type\}\.csv/, 'writes a file to download');
  assert.match(backlog, /invalid-language-ids-all-claims-\$\{type\}\.csv/);
});

test('blank and placeholder ids are not reported as invalid', () => {
  const body = source.slice(source.indexOf('const [invalidMCIDs]'), source.indexOf('context.outputs'));
  for (const clause of ["!= '-'", "!= ''", 'IS NOT NULL']) {
    assert.ok(body.includes(clause), `missing ${clause}`);
  }
});

test('ignored patterns still apply, to both scopes', () => {
  // the upload-scoped checks read channel_id off the joined target table; the
  // backlog reads it off the table it is scanning, so each scope builds its own
  assert.match(source, /const ignoredMCIDRows =/);
  assert.match(source, /writeBacklog\(bq, type, targetTable, context\)/);
  const backlog = source.slice(source.indexOf('async function writeBacklog'), source.indexOf('// Group bad rows'));
  assert.match(backlog, /IGNORED_MCID_PATTERNS/);
  assert.match(backlog, /IGNORED_CHANNEL_PATTERNS/);
});

// Run it for real against the fake client, so the assertions are about the SQL
// that executes rather than the text of the file.
test('the queries it actually runs are scoped to the upload', async () => {
  const { dir, file } = stageVerdictFile();
  const statements = [];
  const processVerdicts = fakeBigQuery(statements);

  const context = {
    files: { mcnVerdicts: file },
    outputs: {},
    options: { exportDir: path.join(dir, 'exports') }
  };
  await processVerdicts(context);
  fs.rmSync(dir, { recursive: true, force: true });

  const selects = statements.filter(s => s.startsWith('SELECT'));
  const perFile = selects.filter(s => /FROM `[^`]*\.mcn_verdicts_\d{8}` v/.test(s));
  assert.strictEqual(perFile.length, 2, 'both id checks read this upload\'s table');
  assert.ok(perFile.every(s => /LEFT JOIN `[^`]*\.youtube_mcn_claims` c/.test(s)),
    'joined only to fetch channel and views for the report');

  const allTime = selects.filter(s => /FROM `[^`]*\.youtube_mcn_claims` v WHERE/.test(s));
  assert.strictEqual(allTime.length, 2, 'the backlog is still read from the whole table');

  assert.deepStrictEqual(context.outputs.mcnVerdicts.acrossAllClaims,
    { invalidMCIDs: 0, invalidLanguageIDs: 0, files: { invalidMCIDs: null, invalidLanguageIDs: null } });
  assert.strictEqual(context.outputs.mcnVerdicts.processed, 1);
});

test('one row per video_id reaches the merge', async () => {
  // BigQuery rejects a MERGE whose source matches the same target row twice
  const { dir, file } = stageVerdictFile();
  const statements = [];
  const processVerdicts = fakeBigQuery(statements);

  await processVerdicts({
    files: { mcnVerdicts: file },
    outputs: {},
    options: { exportDir: path.join(dir, 'exports') }
  });
  fs.rmSync(dir, { recursive: true, force: true });

  const merge = statements.find(s => s.startsWith('MERGE'));
  assert.ok(merge, 'the verdicts are applied with a MERGE');
  assert.match(merge, /QUALIFY ROW_NUMBER\(\) OVER \(PARTITION BY video_id/);
});

test('bad ids are grouped, worst first, with examples to look at', async () => {
  const { dir, file } = stageVerdictFile();

  // three rows share one bad id, one row has another: 2 ids, 4 rows
  const badMCIDs = [
    { video_id: 'v1', media_component_id: '1_jf61??-0-0' },
    { video_id: 'v2', media_component_id: '1_jf61??-0-0' },
    { video_id: 'v3', media_component_id: '1_jf61??-0-0' },
    { video_id: 'v4', media_component_id: 'MC005' },
  ];
  const processVerdicts = fakeBigQuery([], (select) => (select === 1 ? badMCIDs : []));

  const context = {
    files: { mcnVerdicts: file },
    outputs: {},
    options: { exportDir: path.join(dir, 'exports') }
  };
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

test('the backlog is written as a file, in the same shape as the other downloads', async () => {
  const { dir, file } = stageVerdictFile();

  // 1st select: bad MCIDs in the upload, 2nd: bad languages in the upload,
  // 3rd and 4th: the same two questions asked of the whole table
  const backlogLanguages = [
    { video_id: 'old1', language_id: '139124', channel_id: 'UC1' },
    { video_id: 'old2', language_id: '22197', channel_id: 'UC2' }
  ];
  const processVerdicts = fakeBigQuery([], (select) => (select === 4 ? backlogLanguages : []));

  const exportDir = path.join(dir, 'exports');
  const context = {
    files: { mcnVerdicts: file },
    outputs: {},
    options: { exportDir }
  };
  await processVerdicts(context);

  const all = context.outputs.mcnVerdicts.acrossAllClaims;
  assert.strictEqual(all.invalidLanguageIDs, 2, 'the backlog is counted');
  assert.strictEqual(all.files.invalidLanguageIDs, 'invalid-language-ids-all-claims-mcn.csv');
  assert.strictEqual(all.files.invalidMCIDs, null, 'no file when there is nothing in it');

  const written = fs.readFileSync(path.join(exportDir, all.files.invalidLanguageIDs), 'utf8').trim().split('\n');
  assert.strictEqual(written[0], '"video_id","language_id","channel_id"', 'same columns as a claims export');
  assert.strictEqual(written.length, 3, 'one line per row');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the Slack backlog covers both tables, not just MCN', () => {
  const notifier = fs.readFileSync(path.join(__dirname, '..', 'src/lib/slackNotifier.js'), 'utf8');
  const line = notifier.slice(notifier.indexOf('const backlog ='), notifier.indexOf('if (mcids.rows'));
  assert.match(line, /'mcnVerdicts', 'jfmVerdicts'/, 'a JFM-only run must not report a backlog of zero');
  assert.doesNotMatch(line, /results\?\.mcnVerdicts\?\.acrossAllClaims/);
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
