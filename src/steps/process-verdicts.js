const fs = require('fs').promises;
const path = require('path');
const { format } = require('date-fns');
const csv = require('csv-parse/sync');
const { cleanRow } = require('../lib/utils');
const { getBigQueryClient, getDataset, getTable, tableRef, coreTableRef, escapeValue } = require('../lib/bigquery');


async function processVerdicts(context) {

  // Process MCN verdicts
  if (context.files.mcnVerdicts) {
    await processVerdictFile(
      context.files.mcnVerdicts,
      'mcn',
      context
    );
  }

  // Process JFM verdicts
  if (context.files.jfmVerdicts) {
    await processVerdictFile(
      context.files.jfmVerdicts,
      'jfm',
      context
    );
  }
}

async function processVerdictFile(filePath, type, context) {
  const bq = getBigQueryClient();
  const dataset = getDataset();
  const tableName = `${type}_verdicts_${format(new Date(), 'yyyyMMdd')}`;

  // Create verdicts table
  const [exists] = await getTable(tableName).exists();
  if (!exists) {
    await dataset.createTable(tableName, {
      schema: {
        fields: [
          { name: 'video_id', type: 'STRING', mode: 'REQUIRED' },
          { name: 'verdict', type: 'STRING' },
          { name: 'media_component_id', type: 'STRING' },
          { name: 'language_id', type: 'STRING' },
          { name: 'wave', type: 'STRING' },
          { name: 'no_code', type: 'STRING' },
        ]
      }
    });
  } else {
    await bq.query({ query: `TRUNCATE TABLE ${tableRef(tableName)}` });
  }

  // Read and parse CSV
  const fileContent = await fs.readFile(filePath, 'utf8');
  const rows = csv.parse(fileContent, { columns: true });

  // Clean data
  const cleaned = rows.map(row => {
    const cleanedRow = cleanRow(row);
    return {
      video_id: cleanedRow.video_id,
      verdict: cleanedRow.verdict || 'U',
      media_component_id: cleanedRow.media_component_id === '' ? null : cleanedRow.media_component_id,
      language_id: cleanedRow.language_id === '' ? null : cleanedRow.language_id,
      wave: cleanedRow.wave || '0',
      no_code: cleanedRow.no_code === '' ? null : cleanedRow.no_code
    };
  });

  // Insert via DML query (immediately available for MERGE, unlike streaming insert)
  const BATCH_SIZE = 1000;
  for (let i = 0; i < cleaned.length; i += BATCH_SIZE) {
    const batch = cleaned.slice(i, i + BATCH_SIZE);
    const values = batch.map(r =>
      `(${escapeValue(r.video_id)}, ${escapeValue(r.verdict)}, ${escapeValue(r.media_component_id)}, ${escapeValue(r.language_id)}, ${escapeValue(r.wave)}, ${escapeValue(r.no_code)})`
    ).join(',\n');

    await bq.query({
      query: `INSERT INTO ${tableRef(tableName)} (video_id, verdict, media_component_id, language_id, wave, no_code) VALUES ${values}`
    });
  }

  // Merge verdicts into target table
  const targetTable = type === 'mcn' ? 'youtube_mcn_claims' : 'youtube_channel_videos';
  const timestampField = type === 'mcn' ? 'verdict_last_updated_date' : 'updated_at';

  const mergeQuery = `
    MERGE ${tableRef(targetTable)} AS c
    USING (
      SELECT * FROM ${tableRef(tableName)}
      QUALIFY ROW_NUMBER() OVER (PARTITION BY video_id ORDER BY video_id) = 1
    ) AS v
    ON c.video_id = v.video_id
    WHEN MATCHED THEN UPDATE SET
      c.verdict = COALESCE(v.verdict, c.verdict),
      c.wave = COALESCE(v.wave, c.wave),
      c.media_component_id = CASE
        WHEN v.media_component_id IS NULL THEN c.media_component_id
        WHEN v.media_component_id = '-' THEN NULL
        ELSE v.media_component_id
      END,
      c.language_id = CASE
        WHEN v.language_id IS NULL THEN c.language_id
        WHEN v.language_id = '-' THEN NULL
        ELSE v.language_id
      END,
      c.no_code = COALESCE(v.no_code, c.no_code),
      c.${timestampField} = CURRENT_TIMESTAMP()
  `;

  const [mergeJob] = await bq.createQueryJob({ query: mergeQuery });
  await mergeJob.getQueryResults();
  const [jobMetadata] = await mergeJob.getMetadata();
  const mergeStats = jobMetadata.statistics.query.dmlStats || {};
  console.log(`Merged ${type} verdicts into ${targetTable}: ${mergeStats.insertedRowCount || 0} inserted, ${mergeStats.updatedRowCount || 0} updated`);

  // Validate invalid MCIDs
  const invalidMCIDQuery = `
    SELECT * FROM ${tableRef(tableName)} v
    WHERE v.media_component_id IS NOT NULL
    AND v.media_component_id != '-'
    AND v.media_component_id NOT IN (
      SELECT media_component_id FROM ${coreTableRef('bi_view_media_component')}
    )
    ${process.env.IGNORED_MCID_PATTERNS ?
      `AND NOT REGEXP_CONTAINS(v.media_component_id, r'${process.env.IGNORED_MCID_PATTERNS.split(',')
        .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}')`
      : ''}
  `;
  const [invalidMCIDs] = await bq.query({ query: invalidMCIDQuery });

  // Validate invalid language IDs
  const invalidLangQuery = `
    SELECT * FROM ${tableRef(tableName)} v
    WHERE v.language_id IS NOT NULL
    AND v.language_id != '-'
    AND v.language_id NOT IN (
      SELECT wess_lang_id FROM ${coreTableRef('bi_view_media_language')}
    )
  `;
  const [invalidLanguageIDs] = await bq.query({ query: invalidLangQuery });

  context.outputs[`${type}Verdicts`] = {
    processed: cleaned.length,
    invalidMCIDs,
    invalidLanguageIDs
  };
}

module.exports = processVerdicts;