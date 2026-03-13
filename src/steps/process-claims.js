const fs = require('fs');
const csv = require('csv-parse');
const { format } = require('date-fns');
const { cleanRow } = require('../lib/utils');
const { getBigQueryClient, getDataset, getTable, tableRef, coreTableRef, escapeValue } = require('../lib/bigquery');


async function processClaims(context, claimsSource) {

  const claims = context.files.claims?.[claimsSource];
  if (!claims) return;

  const bq = getBigQueryClient();
  const dataset = getDataset();
  const tableName = `claim_report_${format(new Date(), 'yyyyMMdd')}_${claimsSource}`;

  // Create temp table by copying schema from youtube_mcn_claims
  // Excluded columns are system-managed fields that should never come from the CSV.
  const [tempExists] = await getTable(tableName).exists();
  if (!tempExists) {
    const [metadata] = await getTable('youtube_mcn_claims').getMetadata();
    const excludedCols = ['claim_last_updated_date', 'verdict_last_updated_date', 'views_last_updated_date'];
    const schema = metadata.schema.fields.filter(f => !excludedCols.includes(f.name));
    await dataset.createTable(tableName, { schema: { fields: schema } });
  } else {
    // Truncate if table exists from a previous run
    await bq.query({ query: `TRUNCATE TABLE ${tableRef(tableName)}` });
  }

  // Get schema for type-aware inserts
  const [schemaMetadata] = await getTable(tableName).getMetadata();
  const schemaFields = {};
  schemaMetadata.schema.fields.forEach(f => { schemaFields[f.name] = f.type; });

  // Parse and filter claims
  const rows = await parseCSV(claims);
  const filtered = rows.filter(row =>
    row.asset_labels?.includes('Jesus Film') ||
    (row.claim_origin === 'WEB_UPLOAD_BY_OWNER' && row.channel_id === 'UCCtcQHR6-mQHQh6G06IPlDA')
  );

  filtered.forEach(row => { row.claim_report_source = claimsSource });

  // Set defaults for required fields not present in YouTube CSV
  filtered.forEach(row => {
    if (!row.verdict) row.verdict = 'U';
    if (!row.wave) row.wave = '0';
  });

  // Batch insert into temp table
  const BATCH_SIZE = 5000;
  for (let i = 0; i < filtered.length; i += BATCH_SIZE) {
    const batch = filtered.slice(i, i + BATCH_SIZE);
    const columns = Object.keys(batch[0]).filter(col => schemaFields[col]);

    const values = batch.map(row =>
      `(${columns.map(col => escapeValue(row[col], schemaFields[col])).join(', ')})`
    ).join(',\n');

    console.log(`Inserting ${batch.length} rows with ${columns.length} columns into ${tableName} (table has ${Object.keys(schemaFields).length} columns)`);
    await bq.query({
      query: `INSERT INTO ${tableRef(tableName)} (${columns.join(', ')}) VALUES ${values}`
    });

    if (i % 50000 === 0) {
      console.log(`Processed ${i}/${filtered.length} claims`);
    }
  }

  // Merge new claims into youtube_mcn_claims
  const tempCols = Object.keys(schemaFields);   // Get temp table columns for MERGE insert

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

  // Validate for invalid media_component_id
  const invalidMCIDQuery = `
    SELECT v.video_id, v.media_component_id, v.channel_id, v.wave, v.views
    FROM ${tableRef('youtube_mcn_claims')} v
    INNER JOIN ${tableRef(tableName)} t ON v.video_id = t.video_id
    WHERE v.media_component_id != '-'
    AND v.media_component_id NOT IN (
      SELECT media_component_id FROM ${coreTableRef('bi_view_media_component')}
    )
    ${process.env.IGNORED_MCID_PATTERNS ?
      `AND NOT REGEXP_CONTAINS(v.media_component_id, r'${process.env.IGNORED_MCID_PATTERNS.split(',')
        .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}')`
      : ''}
  `;
  const [invalidMCIDs] = await bq.query({ query: invalidMCIDQuery });

  // Validate for invalid language_id
  const invalidLangQuery = `
    SELECT v.video_id, v.language_id, v.channel_id
    FROM ${tableRef('youtube_mcn_claims')} v
    INNER JOIN ${tableRef(tableName)} t ON v.video_id = t.video_id
    WHERE v.language_id != '-'
    AND v.language_id NOT IN (
      SELECT wess_lang_id FROM ${coreTableRef('bi_view_media_language')}
    )
  `;
  const [invalidLanguageIDs] = await bq.query({ query: invalidLangQuery });

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

function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filePath)
      .pipe(csv.parse({ columns: true, skip_empty_lines: true }))
      .on('data', (row) => { rows.push(cleanRow(row)) })
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

module.exports = processClaims;