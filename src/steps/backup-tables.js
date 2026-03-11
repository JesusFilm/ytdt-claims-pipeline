const { getDataset, getTable } = require('../lib/bigquery');


async function backupTables(context) {
  const dataset = getDataset();
  const date = new Date().toISOString().split('T')[0].replace(/-/g, '_');
  const backupName = `youtube_mcn_claims_bkup_${date}`;

  const [backupExists] = await getTable(backupName).exists();
  if (backupExists) {
    console.log(`Backup already exists: ${backupName}`);
    return;
  }

  const [job] = await getTable('youtube_mcn_claims').copy(dataset.table(backupName));
  console.log(`Backup created: ${backupName} (status: ${job.status.state})`);
}

module.exports = backupTables;