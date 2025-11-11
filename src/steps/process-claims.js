import { createReadStream } from 'fs'

import csv from 'csv-parse'
import { format } from 'date-fns'

import { cleanRow } from '../lib/utils.js'

export default async function processClaims(context, claimsSource) {
  const claims = context.files.claims?.[claimsSource]
  if (!claims) return

  const mysql = context.connections.mysql
  const tableName = `claim_report_${format(new Date(), 'yyyyMMdd')}_${claimsSource}`

  // Create temp table
  await mysql.query(`CREATE TABLE IF NOT EXISTS ${tableName} LIKE youtube_mcn_claims`)

  // Parse and insert claims
  const rows = await parseCSV(claims)
  const filtered = rows.filter(
    (row) =>
      row.asset_labels?.includes('Jesus Film') ||
      (row.claim_origin === 'WEB_UPLOAD_BY_OWNER' && row.channel_id === 'UCCtcQHR6-mQHQh6G06IPlDA')
  )

  filtered.forEach((row) => {
    row.claim_report_source = claimsSource
  })

  // Batch insert
  const BATCH_SIZE = 5000
  for (let i = 0; i < filtered.length; i += BATCH_SIZE) {
    const batch = filtered.slice(i, i + BATCH_SIZE)
    await insertBatch(mysql, tableName, batch)

    if (i % 50000 === 0) {
      console.log(`Processed ${i}/${filtered.length} claims`)
    }
  }

  // Merge new claims
  const [result] = await mysql.query(`
    INSERT INTO youtube_mcn_claims
    SELECT * FROM ${tableName}
    WHERE video_id NOT IN (SELECT video_id FROM youtube_mcn_claims)
    AND video_id != ''
  `)

  if (!context.outputs.claimsProcessed) {
    context.outputs.claimsProcessed = {}
  }
  context.outputs.claimsProcessed[claimsSource] = {
    total: filtered.length,
    new: result.affectedRows,
  }
}

function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const rows = []
    createReadStream(filePath)
      .pipe(csv.parse({ columns: true, skip_empty_lines: true }))
      .on('data', (row) => {
        rows.push(cleanRow(row))
      })
      .on('end', () => resolve(rows))
      .on('error', reject)
  })
}

async function insertBatch(mysql, table, batch) {
  if (batch.length === 0) return

  const columns = Object.keys(batch[0])
  const values = batch.map((row) => columns.map((col) => mysql.escape(row[col])))

  const sql = `
    INSERT INTO ${table} (${columns.join(',')})
    VALUES ${values.map((v) => `(${v.join(',')})`).join(',')}
    ON DUPLICATE KEY UPDATE claim_last_updated_date = NOW()
  `

  await mysql.query(sql)
}
