const fs = require('fs').promises;
const path = require('path');
const { generateRunFolderName } = require('../lib/utils');
const { getBigQueryClient, tableRef } = require('../lib/bigquery');


async function exportViews(context) {

  const bq = getBigQueryClient();
  const exportDir = path.join(process.cwd(), 'data', 'exports', generateRunFolderName(context.startTime));
  await fs.mkdir(exportDir, { recursive: true });

  const views = [
    { name: 'export_all_claims', file: 'all_claims.csv' },
    { name: 'export_owned_videos', file: 'owned_videos.csv' },
    { name: 'export_unprocessed_claims', file: 'unprocessed_claims.csv' }
  ];

  context.outputs.exports = {};

  for (const view of views) {
    console.log(`Exporting ${view.name}...`);

    const filePath = path.join(exportDir, view.file);
    const [job] = await bq.createQueryJob({ query: `SELECT * FROM ${tableRef(view.name)}` });
    const [metadata] = await job.getMetadata();

    // Stream rows directly to CSV file
    let rowCount = 0;
    let headerWritten = false;

    await new Promise((resolve, reject) => {
      const writeStream = require('fs').createWriteStream(filePath);
      const queryStream = job.getQueryResultsStream();

      queryStream.on('data', (row) => {
        if (!headerWritten) {
          writeStream.write(Object.keys(row).join(',') + '\n');
          headerWritten = true;
        }
        const values = Object.values(row).map(v =>
          v === null || v === undefined ? '' : `"${String(v).replace(/"/g, '""')}"`
        );
        writeStream.write(values.join(',') + '\n');
        rowCount++;
      });

      queryStream.on('end', () => { writeStream.end(); resolve(); });
      queryStream.on('error', reject);
      writeStream.on('error', reject);
    });

    if (rowCount === 0) {
      console.log(`No data in ${view.name}`);
      continue;
    }

    context.outputs.exports[view.name] = {
      path: filePath,
      rows: rowCount
    };
  }

  console.log(`Exported ${Object.keys(context.outputs.exports).length} views`);
}

module.exports = exportViews;