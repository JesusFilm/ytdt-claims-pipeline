const fs = require('fs');
const csv = require('csv-parse');
const { format } = require('date-fns');
const { cleanRow } = require('../lib/utils');


async function processClaims(context) {

  const { claims, claimsSource } = context.files;
  if (!claims) return;

  const mysql = context.connections.mysql;
  const tableName = `claim_report_${format(new Date(), 'yyyyMMdd')}_${claimsSource}`;
  
  // Create temp table
  await mysql.query(`CREATE TABLE IF NOT EXISTS ${tableName} LIKE youtube_mcn_claims`);
  
  // Parse and insert claims
  const rows = await parseCSV(claims);
  const filtered = rows.filter(row => 
    row.asset_labels?.includes('Jesus Film') ||
    (row.claim_origin === 'WEB_UPLOAD_BY_OWNER' && row.channel_id === 'UCCtcQHR6-mQHQh6G06IPlDA')
  );

  // Batch insert
  const BATCH_SIZE = 5000;
  for (let i = 0; i < filtered.length; i += BATCH_SIZE) {
    const batch = filtered.slice(i, i + BATCH_SIZE);
    await insertBatch(mysql, tableName, batch);
    
    if (i % 50000 === 0) {
      console.log(`Processed ${i}/${filtered.length} claims`);
    }
  }

  // Merge new claims
  const [result] = await mysql.query(`
    INSERT INTO youtube_mcn_claims
    SELECT * FROM ${tableName}
    WHERE video_id NOT IN (SELECT video_id FROM youtube_mcn_claims)
    AND video_id != ''
  `);

  context.outputs.claimsProcessed = {
    total: filtered.length,
    new: result.affectedRows
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

async function insertBatch(mysql, table, batch) {
  if (batch.length === 0) return;
  
  const columns = Object.keys(batch[0]);
  const values = batch.map(row => 
    columns.map(col => mysql.escape(row[col]))
  );
  
  const sql = `
    INSERT INTO ${table} (${columns.join(',')})
    VALUES ${values.map(v => `(${v.join(',')})`).join(',')}
    ON DUPLICATE KEY UPDATE claim_last_updated_date = NOW()
  `;
  
  await mysql.query(sql);
}

module.exports = processClaims;