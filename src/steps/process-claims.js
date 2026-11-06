const fs = require('fs');
const csv = require('csv-parse');
const { format } = require('date-fns');
const { cleanRow, toRegexp } = require('../lib/utils');
const { getBigQueryClient, getDataset, getTable, tableRef, coreTableRef, escapeValue } = require('../lib/bigquery');


async function processClaims(context, claimsSource) {

  const claims = context.files.claims?.[claimsSource];
  if (!claims) return;

  const bq = getBigQueryClient();
  const dataset = getDataset();
  const tableName = `claim_report_${format(new Date(), 'yyyyMMdd')}_${claimsSource}`;

  // Temp table takes its schema from youtube_mcn_claims, minus the columns the
  // database fills in itself — a CSV must never set those.
  const [tempExists] = await getTable(tableName).exists();
  if (!tempExists) {
    const [metadata] = await getTable('youtube_mcn_claims').getMetadata();
    const excludedCols = ['claim_last_updated_date', 'verdict_last_updated_date', 'views_last_updated_date'];
    const schema = metadata.schema.fields.filter(f => !excludedCols.includes(f.name));
    await dataset.createTable(tableName, { schema: { fields: schema } });
  } else {
    // A re-run of the same day lands on the same table name
    await bq.query({ query: `TRUNCATE TABLE ${tableRef(tableName)}` });
  }

  // Column types, so a number goes in unquoted and an empty cell becomes NULL
  const [schemaMetadata] = await getTable(tableName).getMetadata();
  const schemaFields = {};
  schemaMetadata.schema.fields.forEach(f => { schemaFields[f.name] = f.type; });

  // Parse and insert claims, filtering while streaming: reports run to ~1.5M rows
  const filtered = await parseCSV(claims, isJesusFilmClaim);

  filtered.forEach(row => { row.claim_report_source = claimsSource });

  // Required by the table, absent from YouTube's CSV
  filtered.forEach(row => {
    if (!row.verdict) row.verdict = 'U';
    if (!row.wave) row.wave = '0';
  });

  // Batch insert
  const BATCH_SIZE = 5000;
  for (let i = 0; i < filtered.length; i += BATCH_SIZE) {
    const batch = filtered.slice(i, i + BATCH_SIZE);
    await insertBatch(bq, tableName, batch, schemaFields);

    if (i % 50000 === 0) {
      console.log(`Processed ${i}/${filtered.length} claims`);
    }
  }

  // Merge new claims. QUALIFY keeps one row per video_id: BigQuery rejects a
  // MERGE whose source matches the same target row twice, and a report can
  // list a video more than once.
  const tempCols = Object.keys(schemaFields);
  const mergeQuery = `
    MERGE ${tableRef('youtube_mcn_claims')} AS target
    USING (
      SELECT * FROM ${tableRef(tableName)}
      QUALIFY ROW_NUMBER() OVER (PARTITION BY video_id ORDER BY video_id) = 1
    ) AS source
    ON target.video_id = source.video_id
    WHEN NOT MATCHED AND source.video_id != '' THEN
      INSERT (${tempCols.join(', ')})
      VALUES (${tempCols.map(c => `source.${c}`).join(', ')})
    WHEN MATCHED THEN
      UPDATE SET claim_last_updated_date = CURRENT_TIMESTAMP()
  `;

  const [mergeJob] = await bq.createQueryJob({ query: mergeQuery });
  await mergeJob.getQueryResults();
  const [jobMetadata] = await mergeJob.getMetadata();
  const mergeStats = jobMetadata.statistics.query.dmlStats || {};
  console.log(`Merged claims from ${tableName}: ${mergeStats.insertedRowCount || 0} inserted, ${mergeStats.updatedRowCount || 0} updated`);

  // Rows nobody wants reported: placeholder ids (IGNORED_MCID_PATTERNS) and
  // test channels (IGNORED_CHANNEL_PATTERNS). The channel half goes on both
  // checks; the mcid half only on the media_component_id one, since a
  // placeholder mcid is no reason to stop reporting a bad language id.
  //
  // Both are NULL-safe on purpose — REGEXP_CONTAINS(NULL, ...) is NULL, not
  // false, so an unguarded clause silently drops every row whose column is
  // empty.
  const ignoreChannel = process.env.IGNORED_CHANNEL_PATTERNS
    ? `AND (v.channel_id IS NULL OR NOT REGEXP_CONTAINS(v.channel_id, r'${toRegexp(process.env.IGNORED_CHANNEL_PATTERNS)}'))`
    : '';
  const ignoreMCID = process.env.IGNORED_MCID_PATTERNS
    ? `AND (v.media_component_id IS NULL OR NOT REGEXP_CONTAINS(v.media_component_id, r'${toRegexp(process.env.IGNORED_MCID_PATTERNS)}'))`
    : '';

  // Validate youtube_mcn_claims for invalid media_component_id
  const [invalidMCIDs] = await bq.query({
    query: `
      SELECT v.video_id, v.media_component_id, v.channel_id, v.wave, v.views
      FROM ${tableRef('youtube_mcn_claims')} v
      INNER JOIN ${tableRef(tableName)} t ON v.video_id = t.video_id
      WHERE v.media_component_id != '-'
      AND v.media_component_id NOT IN (
        SELECT media_component_id FROM ${coreTableRef('bi_view_media_component')}
      )
      ${ignoreMCID}
      ${ignoreChannel}
    `
  });

  // Validate youtube_mcn_claims for invalid language_id. BigQuery compares
  // strings byte for byte, so MySQL's CONVERT/COLLATE dance is not needed.
  const [invalidLanguageIDs] = await bq.query({
    query: `
      SELECT v.video_id, v.language_id, v.channel_id
      FROM ${tableRef('youtube_mcn_claims')} v
      INNER JOIN ${tableRef(tableName)} t ON v.video_id = t.video_id
      WHERE v.language_id != '-'
      AND v.language_id NOT IN (
        SELECT wess_language_id FROM ${coreTableRef('bi_view_media_language')}
      )
      ${ignoreChannel}
    `
  });

  if (!context.outputs.claimsProcessed) {
    context.outputs.claimsProcessed = {};
  }
  context.outputs.claimsProcessed[claimsSource] = {
    total: filtered.length,
    new: parseInt(mergeStats.insertedRowCount || 0),
    invalidMCIDs,
    invalidLanguageIDs
  };
}

function isJesusFilmClaim(row) {
  return row.asset_labels?.includes('Jesus Film') ||
    (row.claim_origin === 'WEB_UPLOAD_BY_OWNER' && row.channel_id === 'UCCtcQHR6-mQHQh6G06IPlDA');
}

function parseCSV(filePath, keep) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filePath)
      .pipe(csv.parse({ columns: true, skip_empty_lines: true }))
      .on('data', (row) => {
        const cleaned = cleanRow(row);
        if (keep(cleaned)) rows.push(cleaned);
      })
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

async function insertBatch(bq, table, batch, schemaFields) {
  if (batch.length === 0) return;

  // A column the table does not have would fail the whole insert
  const columns = Object.keys(batch[0]).filter(col => schemaFields[col]);
  const values = batch.map(row =>
    `(${columns.map(col => escapeValue(row[col], schemaFields[col])).join(', ')})`
  ).join(',\n');

  await bq.query({
    query: `INSERT INTO ${tableRef(table)} (${columns.join(', ')}) VALUES ${values}`
  });
}

module.exports = processClaims;
