import { createReadStream } from 'fs'

import { parse } from 'csv-parse'
import { format } from 'date-fns'

import { cleanRow } from '../../lib/utils'

import type { PipelineContext } from '../../types/pipeline'
import type { Pool, ResultSetHeader } from 'mysql2/promise'

export default async function processClaims(
  context: PipelineContext,
  claimsSource: 'matter_entertainment' | 'matter_2'
) {
  const claims = context.files.claims?.[claimsSource]
  if (!claims) return

  const mysql = context.connections.mysql
  if (!mysql) throw new Error('MySQL connection not available')

  const tableName = `claim_report_${format(new Date(), 'yyyyMMdd')}_${claimsSource}`

  // Create temp table
  await mysql.query(`CREATE TABLE IF NOT EXISTS ${tableName} LIKE youtube_mcn_claims`)

  // Parse and insert claims
  const rows = await parseCSV(claims)
  const filtered = rows.filter(
    (row) =>
      (row.asset_labels as string | undefined)?.includes('Jesus Film') ||
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

  const claimsProcessed =
    (context.outputs.claimsProcessed as Record<string, { total: number; new: number }>) || {}
  claimsProcessed[claimsSource] = {
    total: filtered.length,
    new: (result as ResultSetHeader).affectedRows,
  }
  context.outputs.claimsProcessed = claimsProcessed
}

function parseCSV(filePath: string): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const rows: Record<string, unknown>[] = []
    createReadStream(filePath)
      .pipe(parse({ columns: true, skip_empty_lines: true }))
      .on('data', (row) => {
        rows.push(cleanRow(row))
      })
      .on('end', () => resolve(rows))
      .on('error', reject)
  })
}

async function insertBatch(mysql: Pool, table: string, batch: Record<string, unknown>[]) {
  if (batch.length === 0) return

  const columns = Object.keys(batch[0])
  const values = batch.map((row) => columns.map((col) => mysql.escape(String(row[col] || ''))))

  const sql = `
    INSERT INTO ${table} (${columns.join(',')})
    VALUES ${values.map((v) => `(${v.join(',')})`).join(',')}
    ON DUPLICATE KEY UPDATE claim_last_updated_date = NOW()
  `

  await mysql.query(sql)
}
