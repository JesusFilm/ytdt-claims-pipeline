import fs from 'fs/promises'
import path from 'path'

import { stringify } from 'csv-stringify/sync'

import { generateRunFolderName } from '../../lib/utils/index.js'

export default async function exportViews(context) {
  const mysql = context.connections.mysql
  const exportDir = path.join(
    process.cwd(),
    'data',
    'exports',
    generateRunFolderName(context.startTime)
  )
  await fs.mkdir(exportDir, { recursive: true })

  const views = [
    { name: 'export_all_claims', file: 'all_claims.csv' },
    { name: 'export_owned_videos', file: 'owned_videos.csv' },
    { name: 'export_unprocessed_claims', file: 'unprocessed_claims.csv' },
  ]

  context.outputs.exports = {}

  for (const view of views) {
    console.log(`Exporting ${view.name}...`)

    // Query view
    const [rows] = await mysql.query(`SELECT * FROM ${view.name}`)

    if (rows.length === 0) {
      console.log(`No data in ${view.name}`)
      continue
    }

    // Convert to CSV
    const csv = stringify(rows, { header: true })

    // Save file
    const filePath = path.join(exportDir, view.file)
    await fs.writeFile(filePath, csv)

    context.outputs.exports[view.name] = {
      path: filePath,
      rows: rows.length,
    }
  }

  console.log(`Exported ${Object.keys(context.outputs.exports).length} views`)
}
