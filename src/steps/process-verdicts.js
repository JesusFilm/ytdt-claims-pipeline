const fs = require('fs').promises;
const path = require('path');
const { format } = require('date-fns');
const csv = require('csv-parse/sync');
const { cleanRow } = require('../lib/utils');


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
      no_code VARCHAR(255)
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
      no_code: cleanedRow.no_code === '' ? null : cleanedRow.no_code
    };
  });

  // Insert verdicts
  for (let i = 0; i < cleaned.length; i += 1000) {
    const batch = cleaned.slice(i, i + 1000);
    const values = batch.map(r =>
      `(${mysql.escape(r.video_id)}, ${mysql.escape(r.verdict)}, 
        ${mysql.escape(r.media_component_id)}, ${mysql.escape(r.language_id)}, 
        ${mysql.escape(r.wave)}, ${mysql.escape(r.no_code)})`
    ).join(',');

    await mysql.query(`
      INSERT INTO ${tableName} 
      (video_id, verdict, media_component_id, language_id, wave, no_code)
      VALUES ${values}
      ON DUPLICATE KEY UPDATE verdict = VALUES(verdict)
    `);
  }

  // Update main tables
  const targetTable = type === 'mcn' ? 'youtube_mcn_claims' : 'youtube_channel_videos';

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
        c.no_code = CASE WHEN v.no_code IS NOT NULL THEN v.no_code ELSE c.no_code END
    WHERE c.video_id = v.video_id
  `);

  // Check for invalid MCIDs
  const [invalidMCIDs] = await mysql.query(`
    SELECT COUNT(*) as count FROM ${tableName} v
    WHERE v.media_component_id IS NOT NULL 
    AND v.media_component_id != '-'
    AND v.media_component_id NOT IN (
      SELECT media_component_id FROM bi_view_media_component
    )
  `);

  context.outputs[`${type}Verdicts`] = {
    processed: cleaned.length,
    invalidMCIDs: invalidMCIDs[0].count
  };
}

module.exports = processVerdicts;