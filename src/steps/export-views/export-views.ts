import fs from 'fs/promises'
import path from 'path'

import { stringify } from 'csv-stringify/sync'

import { generateRunFolderName } from '../../lib/utils'

import type { PipelineContext } from '../../types/pipeline'

export default async function exportViews(context: PipelineContext) {
  const mysql = context.connections.mysql
  if (!mysql) throw new Error('MySQL connection not available')

  const exportDir = path.join(
    process.cwd(),
    'data',
    'exports',
    generateRunFolderName(
      context.startTime instanceof Date ? context.startTime : new Date(context.startTime)
    )
  )
  await fs.mkdir(exportDir, { recursive: true })

  const views = [
    { name: 'export_all_claims', file: 'all_claims.csv' },
    { name: 'export_owned_videos', file: 'owned_videos.csv' },
    { name: 'export_unprocessed_claims', file: 'unprocessed_claims.csv' },
  ]

  const exports: Record<string, { path: string; rows: number }> = {}
  context.outputs.exports = exports

  for (const view of views) {
    console.log(`Exporting ${view.name}...`)

    // Query view
    const [rows] = await mysql.query(`SELECT * FROM ${view.name}`)

    if ((rows as unknown[]).length === 0) {
      console.log(`No data in ${view.name}`)
      continue
    }

    // Convert to CSV
    const csv = stringify(rows as Record<string, unknown>[], { header: true })

    // Save file
    const filePath = path.join(exportDir, view.file)
    await fs.writeFile(filePath, csv)

    exports[view.name] = {
      path: filePath,
      rows: (rows as unknown[]).length,
    }
  }

  console.log(`Exported ${Object.keys(exports).length} views`)
}
