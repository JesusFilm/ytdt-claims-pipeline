const fs = require('fs').promises;
const path = require('path');
const { format } = require('date-fns');
const csv = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const { cleanRow, resolveRunExportDir } = require('../lib/utils');


async function processVerdicts(context) {

  const mysql = context.connections.mysql;

  // Process MCN verdicts
  if (context.files.mcnVerdicts) {
    await processVerdictFile(
      mysql,
      context.files.mcnVerdicts,
      'mcn',
      context
    );
  }

  // Process JFM verdicts  
  if (context.files.jfmVerdicts) {
    await processVerdictFile(
      mysql,
      context.files.jfmVerdicts,
      'jfm',
      context
    );
  }
}

async function processVerdictFile(mysql, filePath, type, context) {
  const tableName = `${type}_verdicts_${format(new Date(), 'yyyyMMdd')}`;

  // Create verdicts table
  await mysql.query(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      video_id VARCHAR(191) PRIMARY KEY,
      verdict VARCHAR(1),
      media_component_id VARCHAR(255),
      language_id VARCHAR(255),
      wave VARCHAR(100),
      no_code VARCHAR(255),
      is_edited TINYINT(1)
    )
  `);

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

  // Insert verdicts
  for (let i = 0; i < cleaned.length; i += 1000) {
    const batch = cleaned.slice(i, i + 1000);
    const values = batch.map(r =>
      `(${mysql.escape(r.video_id)}, ${mysql.escape(r.verdict)}, 
        ${mysql.escape(r.media_component_id)}, ${mysql.escape(r.language_id)}, 
        ${mysql.escape(r.wave)}, ${mysql.escape(r.no_code)}, ${mysql.escape(r.is_edited)})`
    ).join(',');

    await mysql.query(`
      INSERT INTO ${tableName} 
      (video_id, verdict, media_component_id, language_id, wave, no_code, is_edited)
      VALUES ${values}
      ON DUPLICATE KEY UPDATE 
        verdict = VALUES(verdict),
        media_component_id = VALUES(media_component_id),
        language_id = VALUES(language_id),
        wave = VALUES(wave),
        no_code = VALUES(no_code),
        is_edited = VALUES(is_edited)
    `);
  }

  // Update main tables
  const targetTable = type === 'mcn' ? 'youtube_mcn_claims' : 'youtube_channel_videos';
  const timestampField = type === 'mcn' ? 'verdict_last_updated_date' : 'updated_at';

  await mysql.query(`
    UPDATE ${targetTable} c, ${tableName} v
    SET c.verdict = CASE WHEN v.verdict IS NOT NULL THEN v.verdict ELSE c.verdict END,
        c.wave = CASE WHEN v.wave IS NOT NULL THEN v.wave ELSE c.wave END,
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
        c.is_edited = CASE WHEN v.is_edited IS NOT NULL THEN v.is_edited ELSE c.is_edited END,
        c.${timestampField} = NOW()
    WHERE c.video_id = v.video_id
  `);

  // Invalid ids in the file that was just uploaded — the rows whoever sent it
  // can actually correct. These used to be read from the whole target table, so
  // every historical bad id was reported again each month under this run's
  // "Data Quality Issues".
  const ignoredMCIDs = process.env.IGNORED_MCID_PATTERNS
    ? `AND v.media_component_id NOT REGEXP '${process.env.IGNORED_MCID_PATTERNS.split(',')
      .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\\\$&')).join('|')}'`
    : '';

  const [invalidMCIDs] = await mysql.query(`
    SELECT v.video_id, v.media_component_id, c.channel_id, v.wave,
      c.${type === 'mcn' ? 'views' : 'lifetime_view_count'} AS views
    FROM ${tableName} v
    LEFT JOIN ${targetTable} c ON c.video_id = v.video_id
    WHERE CONVERT(v.media_component_id USING utf8mb4) COLLATE utf8mb4_bin NOT IN (
      SELECT CONVERT(media_component_id USING utf8mb4) COLLATE utf8mb4_bin FROM bi_view_media_component
    )
    AND v.media_component_id IS NOT NULL
    AND v.media_component_id != '-'
    AND v.media_component_id != ''
    ${ignoredMCIDs}
  `);

  // wess_language_id is the only id column this view exposes. The warehouse's
  // own process_verdicts.sql compares against "language_id", which does not
  // exist here, so MySQL resolves it to the outer table's column and the check
  // always passes — which is why that script reports none and this reports some.
  const [invalidLanguageIDs] = await mysql.query(`
    SELECT v.video_id, v.language_id, c.channel_id
    FROM ${tableName} v
    LEFT JOIN ${targetTable} c ON c.video_id = v.video_id
    WHERE CONVERT(v.language_id USING utf8mb4) COLLATE utf8mb4_bin NOT IN (
      SELECT CONVERT(wess_language_id USING utf8mb4) COLLATE utf8mb4_bin FROM bi_view_media_language
    )
    AND v.language_id IS NOT NULL
    AND v.language_id != '-'
    AND v.language_id != ''
  `);

  // The same questions asked of everything ever loaded. This is the backlog —
  // what nobody has got to yet — and it is listed, not just counted, so it can
  // be worked through instead of only watched.
  const backlog = await writeBacklog(mysql, type, targetTable, ignoredMCIDs, context);

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
// run's other exports so the console and Drive can hand it over. Two queries
// against production, the same two that used to be counted.
async function writeBacklog(mysql, type, targetTable, ignoredMCIDs, context) {
  const views = type === 'mcn' ? 'v.views' : 'v.lifetime_view_count';

  const [mcidRows] = await mysql.query(`
    SELECT v.video_id, v.media_component_id, v.channel_id, v.wave, ${views} AS views
    FROM ${targetTable} v
    WHERE CONVERT(v.media_component_id USING utf8mb4) COLLATE utf8mb4_bin NOT IN (
      SELECT CONVERT(media_component_id USING utf8mb4) COLLATE utf8mb4_bin FROM bi_view_media_component)
    AND v.media_component_id IS NOT NULL
    AND v.media_component_id != '-' AND v.media_component_id != '' ${ignoredMCIDs}
  `);

  const [languageRows] = await mysql.query(`
    SELECT v.video_id, v.language_id, v.channel_id
    FROM ${targetTable} v
    WHERE CONVERT(v.language_id USING utf8mb4) COLLATE utf8mb4_bin NOT IN (
      SELECT CONVERT(wess_language_id USING utf8mb4) COLLATE utf8mb4_bin FROM bi_view_media_language)
    AND v.language_id IS NOT NULL
    AND v.language_id != '-' AND v.language_id != ''
  `);

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
// SQL: the rows are already fetched for the download, and the database is
// production — this asks it nothing more.
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
