const fs = require('fs').promises;
const path = require('path');
const { format } = require('date-fns');
const csv = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const { cleanRow, resolveRunExportDir, toRegexp } = require('../lib/utils');
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

  // Staging table for this upload
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
          { name: 'is_edited', type: 'INT64' },
        ]
      }
    });
  } else {
    // A re-run of the same day lands on the same table name
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
      no_code: cleanedRow.no_code === '' ? null : cleanedRow.no_code,
      is_edited: cleanedRow.is_edited === '' || cleanedRow.is_edited == null ? null : Number(cleanedRow.is_edited)
    };
  });

  // Insert via DML query (immediately available for MERGE, unlike streaming insert)
  const COLUMNS = ['video_id', 'verdict', 'media_component_id', 'language_id', 'wave', 'no_code', 'is_edited'];
  const TYPES = { is_edited: 'INT64' };
  const BATCH_SIZE = 1000;
  for (let i = 0; i < cleaned.length; i += BATCH_SIZE) {
    const batch = cleaned.slice(i, i + BATCH_SIZE);
    const values = batch.map(r =>
      `(${COLUMNS.map(col => escapeValue(r[col], TYPES[col] || 'STRING')).join(', ')})`
    ).join(',\n');

    await bq.query({
      query: `INSERT INTO ${tableRef(tableName)} (${COLUMNS.join(', ')}) VALUES ${values}`
    });
  }

  // Apply verdicts to the target table
  const targetTable = type === 'mcn' ? 'youtube_mcn_claims' : 'youtube_channel_videos';
  const timestampField = type === 'mcn' ? 'verdict_last_updated_date' : 'updated_at';

  // is_edited only exists on some targets; setting a column the table does not
  // have fails the whole MERGE.
  const [targetMetadata] = await getTable(targetTable).getMetadata();
  const targetCols = new Set(targetMetadata.schema.fields.map(f => f.name));
  const setIsEdited = targetCols.has('is_edited')
    ? `c.is_edited = COALESCE(v.is_edited, c.is_edited),`
    : '';

  // QUALIFY keeps one row per video_id: BigQuery rejects a MERGE whose source
  // matches the same target row twice.
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
      c.no_code = CASE
        WHEN v.no_code IS NULL THEN c.no_code
        WHEN v.no_code = '-' THEN NULL
        ELSE v.no_code
      END,
      ${setIsEdited}
      c.${timestampField} = CURRENT_TIMESTAMP()
  `;

  const [mergeJob] = await bq.createQueryJob({ query: mergeQuery });
  await mergeJob.getQueryResults();
  const [jobMetadata] = await mergeJob.getMetadata();
  const mergeStats = jobMetadata.statistics.query.dmlStats || {};
  console.log(`Merged ${type} verdicts into ${targetTable}: ${mergeStats.updatedRowCount || 0} updated`);

  // Invalid ids in the file that was just uploaded — the rows whoever sent it
  // can actually correct. These used to be read from the whole target table, so
  // every historical bad id was reported again each month under this run's
  // "Data Quality Issues".
  // Rows nobody wants reported: placeholder ids (IGNORED_MCID_PATTERNS) and
  // test channels (IGNORED_CHANNEL_PATTERNS). Built per query because the
  // upload-scoped checks read channel_id off the joined target table while the
  // backlog reads it off the table it is scanning.
  //
  // Both halves are NULL-safe on purpose. REGEXP_CONTAINS(NULL, '...') is NULL,
  // not false, so an unguarded clause silently drops every row whose
  // media_component_id is empty — which is most of the backlog.
  // The channel half goes on every check: a test channel's rows are not worth
  // anyone's time whichever column is wrong. The mcid half goes only on the
  // media_component_id checks — a placeholder mcid is no reason to stop
  // reporting that same row's bad language id.
  const ignoreChannel = (alias) => process.env.IGNORED_CHANNEL_PATTERNS
    ? `AND (${alias}.channel_id IS NULL OR NOT REGEXP_CONTAINS(${alias}.channel_id, r'${toRegexp(process.env.IGNORED_CHANNEL_PATTERNS)}'))`
    : '';
  const ignoreMCID = (alias) => process.env.IGNORED_MCID_PATTERNS
    ? `AND (${alias}.media_component_id IS NULL OR NOT REGEXP_CONTAINS(${alias}.media_component_id, r'${toRegexp(process.env.IGNORED_MCID_PATTERNS)}'))`
    : '';

  // The uploaded file is staged as `v`; `c` is the target table it joins to, so
  // channel_id comes off `c` here and off `v` in the backlog.
  const ignoredMCIDRows = `${ignoreMCID('v')}\n    ${ignoreChannel('c')}`;
  const ignoredLanguageRows = ignoreChannel('c');

  // BigQuery compares strings byte for byte, so MySQL's CONVERT/COLLATE dance
  // is not needed on either check.
  const [invalidMCIDs] = await bq.query({
    query: `
      SELECT v.video_id, v.media_component_id, c.channel_id, v.wave,
        c.${type === 'mcn' ? 'views' : 'lifetime_view_count'} AS views
      FROM ${tableRef(tableName)} v
      LEFT JOIN ${tableRef(targetTable)} c ON c.video_id = v.video_id
      WHERE v.media_component_id NOT IN (
        SELECT media_component_id FROM ${coreTableRef('bi_view_media_component')}
      )
      AND v.media_component_id IS NOT NULL
      AND v.media_component_id != '-'
      AND v.media_component_id != ''
      ${ignoredMCIDRows}
    `
  });

  // wess_language_id is the only id column this view exposes. The warehouse's
  // own process_verdicts.sql compares against "language_id", which does not
  // exist here, so the reference resolves to the outer table's column and the
  // check always passes — which is why that script reports none and this
  // reports some.
  const [invalidLanguageIDs] = await bq.query({
    query: `
      SELECT v.video_id, v.language_id, c.channel_id
      FROM ${tableRef(tableName)} v
      LEFT JOIN ${tableRef(targetTable)} c ON c.video_id = v.video_id
      WHERE v.language_id NOT IN (
        SELECT wess_language_id FROM ${coreTableRef('bi_view_media_language')}
      )
      AND v.language_id IS NOT NULL
      AND v.language_id != '-'
      AND v.language_id != ''
      ${ignoredLanguageRows}
    `
  });

  // The same questions asked of everything ever loaded. This is the backlog —
  // what nobody has got to yet — and it is listed, not just counted, so it can
  // be worked through instead of only watched.
  const backlog = await writeBacklog(bq, type, targetTable, context);

  context.outputs[`${type}Verdicts`] = {
    processed: cleaned.length,
    invalidMCIDs,
    invalidLanguageIDs,
    // Two different questions: how many ids to fix, and how many rows they
    // affect. A handful of ids over many rows is a typo repeated; one id per
    // row is a wrong column, and only showing rows hides which you have.
    invalidSummary: {
      mcids: summarise(invalidMCIDs, 'media_component_id'),
      languages: summarise(invalidLanguageIDs, 'language_id')
    },
    // context, not this upload's doing: every bad id still sitting in the
    // table, with the file to download it from.
    acrossAllClaims: backlog
  };
}

// Everything in the claims table that still has a bad id, written beside the
// run's other exports so the console and Drive can hand it over.
async function writeBacklog(bq, type, targetTable, context) {
  const views = type === 'mcn' ? 'v.views' : 'v.lifetime_view_count';

  // Same split as above, but one table: channel_id is on `v` here.
  const ignoreChannel = process.env.IGNORED_CHANNEL_PATTERNS
    ? `AND (v.channel_id IS NULL OR NOT REGEXP_CONTAINS(v.channel_id, r'${toRegexp(process.env.IGNORED_CHANNEL_PATTERNS)}'))`
    : '';
  const ignoreMCID = process.env.IGNORED_MCID_PATTERNS
    ? `AND (v.media_component_id IS NULL OR NOT REGEXP_CONTAINS(v.media_component_id, r'${toRegexp(process.env.IGNORED_MCID_PATTERNS)}'))`
    : '';

  const [mcidRows] = await bq.query({
    query: `
      SELECT v.video_id, v.media_component_id, v.channel_id, v.wave, ${views} AS views
      FROM ${tableRef(targetTable)} v
      WHERE v.media_component_id NOT IN (
        SELECT media_component_id FROM ${coreTableRef('bi_view_media_component')})
      AND v.media_component_id IS NOT NULL
      AND v.media_component_id != '-' AND v.media_component_id != ''
      ${ignoreMCID}
      ${ignoreChannel}
    `
  });

  const [languageRows] = await bq.query({
    query: `
      SELECT v.video_id, v.language_id, v.channel_id
      FROM ${tableRef(targetTable)} v
      WHERE v.language_id NOT IN (
        SELECT wess_language_id FROM ${coreTableRef('bi_view_media_language')})
      AND v.language_id IS NOT NULL
      AND v.language_id != '-' AND v.language_id != ''
      ${ignoreChannel}
    `
  });

  const exportDir = context.options?.exportDir || resolveRunExportDir(context.startTime);
  await fs.mkdir(exportDir, { recursive: true });

  // Same shape as the per-upload downloads, so one file does not read
  // differently from the other.
  const write = async (rows, name) => {
    if (!rows.length) return null;
    const plain = rows.map(row => {
      const out = {};
      for (const [key, value] of Object.entries(row)) out[key] = value == null ? '' : String(value);
      return out;
    });
    await fs.writeFile(path.join(exportDir, name), stringify(plain, { header: true, quoted: true }));
    return name;
  };

  return {
    invalidMCIDs: mcidRows.length,
    invalidLanguageIDs: languageRows.length,
    files: {
      invalidMCIDs: await write(mcidRows, `invalid-mcids-all-claims-${type}.csv`),
      invalidLanguageIDs: await write(languageRows, `invalid-language-ids-all-claims-${type}.csv`)
    }
  };
}

// Group bad rows by the id that is wrong, worst first. Done here rather than in
// SQL: the rows are already fetched for the download, so this asks the
// warehouse nothing more.
function summarise(rows, column, examplesPerId = 3) {
  const byId = new Map();
  for (const row of rows) {
    const id = row[column];
    if (!byId.has(id)) byId.set(id, { id, rows: 0, examples: [] });
    const entry = byId.get(id);
    entry.rows += 1;
    if (entry.examples.length < examplesPerId && row.video_id) entry.examples.push(row.video_id);
  }
  return {
    distinct: byId.size,
    rows: rows.length,
    byId: [...byId.values()].sort((a, b) => b.rows - a.rows)
  };
}

module.exports = processVerdicts;
