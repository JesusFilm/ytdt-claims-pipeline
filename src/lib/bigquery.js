const { BigQuery } = require('@google-cloud/bigquery');


const BQ_DATASET = process.env.BQ_DATASET || 'youtube';
const BQ_CORE_DATASET = process.env.BQ_CORE_ANALYTICS_DATASET || 'core_analytics_views';


let client = null;

function getBigQueryClient() {
  if (client) return client;

  client = new BigQuery({
    projectId: process.env.BQ_PROJECT_ID || 'jfp-data-warehouse',
    keyFilename: process.env.BQ_KEY_FILE || './config/service-account-key.json',
  });

  return client;
}

function getDataset() {
  return getBigQueryClient().dataset(BQ_DATASET);
}

function getTable(tableName) {
  return getDataset().table(tableName);
}

function tableRef(tableName) {
  const projectId = process.env.BQ_PROJECT_ID || 'jfp-data-warehouse';
  return `\`${projectId}.${BQ_DATASET}.${tableName}\``;
}

function coreTableRef(tableName) {
  const projectId = process.env.BQ_PROJECT_ID || 'jfp-data-warehouse';
  return `\`${projectId}.${BQ_CORE_DATASET}.${tableName}\``;
}

// Escape a value for safe use in BQ SQL
function escapeValue(val, bqType) {
  if (val === null || val === undefined || val === '') return 'NULL';
  const str = String(val).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  if (bqType && ['INT64', 'INTEGER', 'FLOAT64', 'FLOAT', 'NUMERIC'].includes(bqType)) {
    return isNaN(Number(str)) ? 'NULL' : str;
  }
  return `'${str}'`;
}

module.exports = { getBigQueryClient, BQ_DATASET, getDataset, getTable, tableRef, coreTableRef, escapeValue };