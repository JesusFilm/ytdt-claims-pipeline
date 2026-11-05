const fs = require('fs').promises;
const path = require('path');
const { createWriteStream } = require('fs');
const { pipeline } = require('stream/promises');
const { stringify } = require('csv-stringify');
const { resolveRunExportDir } = require('../lib/utils');
const { getBigQueryClient, tableRef } = require('../lib/bigquery');
const enrichUnprocessedClaims = require('../lib/enrichUnprocessedClaims');


async function exportViews(context) {

  const bq = getBigQueryClient();
  const options = context.options || {};
  const exportDir = options.exportDir || resolveRunExportDir(context.startTime);
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

    const filePath = path.join(exportDir, view.file);

    // not-available / licensed / media-component enrichment (traditionally by YT-Validator)
    // so these columns are present in the exported unprocessed claims CSV.
    // options.enrichUnprocessed === false skips all of it; options.skipAvailability
    // keeps the free local-CSV joins (licensed, media_component_id) and skips only
    // the availability lookup, which spends YouTube Data API quota shared with production.
    const enrich = view.name === 'export_unprocessed_claims' && options.enrichUnprocessed !== false;

    const rowCount = enrich
      ? await exportEnriched(bq, view, filePath, options)
      : await exportStreaming(bq, view, filePath);

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

// Straight to disk, a row at a time: export_all_claims runs to ~1.5M rows and
// does not fit comfortably in memory.
async function exportStreaming(bq, view, filePath) {
  const [job] = await bq.createQueryJob({ query: `SELECT * FROM ${tableRef(view.name)}` });

  let rowCount = 0;
  const toPlain = async function* (source) {
    for await (const row of source) {
      rowCount++;
      yield plainRow(row);
    }
  };

  await pipeline(
    job.getQueryResultsStream(),
    toPlain,
    stringify({ header: true }),
    createWriteStream(filePath)
  );

  // A view with no rows writes no header, which an empty CSV would anyway.
  if (rowCount === 0) await fs.rm(filePath, { force: true });
  return rowCount;
}

// Enrichment needs every row in hand at once, so this one is buffered. It is
// the unprocessed claims only — the backlog waiting for a verdict, not the
// whole table.
async function exportEnriched(bq, view, filePath, options) {
  const [rows] = await bq.query({ query: `SELECT * FROM ${tableRef(view.name)}` });
  if (rows.length === 0) return 0;

  const plainRows = rows.map(plainRow);
  await enrichUnprocessedClaims(plainRows, { skipAvailability: options.skipAvailability === true });

  await new Promise((resolve, reject) => {
    const out = createWriteStream(filePath);
    stringify(plainRows, { header: true }, (err, csv) => {
      if (err) return reject(err);
      out.end(csv, resolve);
    });
    out.on('error', reject);
  });

  return rows.length;
}

// BigQuery hands back typed values and wrapper objects (BigQueryTimestamp and
// friends); the CSVs downstream read are all strings.
function plainRow(row) {
  const plain = {};
  for (const [key, value] of Object.entries(row)) {
    plain[key] = value === null || value === undefined ? ''
      : typeof value === 'object' && value.value !== undefined ? String(value.value)
      : String(value);
  }
  return plain;
}

module.exports = exportViews;
