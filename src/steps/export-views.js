const fs = require('fs').promises;
const path = require('path');
const { stringify } = require('csv-stringify/sync');
const { generateRunFolderName } = require('../lib/utils');
const enrichUnprocessedClaims = require('../lib/enrichUnprocessedClaims');


async function exportViews(context) {

  const mysql = context.connections.mysql;
  const options = context.options || {};
  const exportDir = options.exportDir || path.join(process.cwd(), 'data', 'exports', generateRunFolderName(context.startTime));
  await fs.mkdir(exportDir, { recursive: true });

  // options.exportViews narrows the export, e.g. the daily claims ingest only
  // needs unprocessed claims. Absent means every view, as pipeline runs expect.
  const views = [
    { name: 'export_all_claims', file: 'all_claims.csv' },
    { name: 'export_owned_videos', file: 'owned_videos.csv' },
    { name: 'export_unprocessed_claims', file: 'unprocessed_claims.csv' }
  ].filter(view => !options.exportViews || options.exportViews.includes(view.name));

  context.outputs.exports = {};

  for (const view of views) {
    console.log(`Exporting ${view.name}...`);

    // Query view
    const [rows] = await mysql.query(`SELECT * FROM ${view.name}`);

    if (rows.length === 0) {
      console.log(`No data in ${view.name}`);
      continue;
    }

    // Convert RowDataPacket objects to plain objects with string values
    const plainRows = rows.map(row => {
      const plain = {};
      for (const [key, value] of Object.entries(row)) {
        plain[key] = value === null || value === undefined ? '' : String(value);
      }
      return plain;
    });

    // not-available / licensed / media-component enrichment (traditionally by YT-Validator)
    // so these columns are present in the exported unprocessed claims CSV.
    // options.enrichUnprocessed === false skips it: the availability lookup
    // spends YouTube Data API quota shared with production.
    if (view.name === 'export_unprocessed_claims' && options.enrichUnprocessed !== false) {
      await enrichUnprocessedClaims(plainRows);
    }

    // Convert to CSV
    const csv = stringify(plainRows, { header: true });

    // Save file
    const filePath = path.join(exportDir, view.file);
    await fs.writeFile(filePath, csv);

    context.outputs.exports[view.name] = {
      path: filePath,
      rows: rows.length
    };
  }

  console.log(`Exported ${Object.keys(context.outputs.exports).length} views`);
}

module.exports = exportViews;