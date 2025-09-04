const fs = require('fs').promises;
const path = require('path');
const { format } = require('date-fns');
const csv = require('csv-parse/sync');


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
  const cleaned = rows.map(row => ({
    video_id: row.video_id?.replace(/^'/, ''), // Remove Excel quotes
    verdict: row.verdict || 'U',
    media_component_id: row.media_component_id === '' ? null : row.media_component_id,
    language_id: row.language_id === '' ? null : row.language_id,
    wave: row.wave || '0',
    no_code: row.no_code === '' ? null : row.no_code
  }));

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
    SET c.verdict = v.verdict,
        c.wave = v.wave,
        c.media_component_id = CASE 
          WHEN v.media_component_id = '-' THEN NULL 
          ELSE v.media_component_id 
        END,
        c.language_id = CASE 
          WHEN v.language_id = '-' THEN NULL 
          ELSE v.language_id 
        END,
        c.no_code = v.no_code
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