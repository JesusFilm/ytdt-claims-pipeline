const { getDatabase } = require('../database');

function collection() {
  return getDatabase().collection('pending_runs');
}

async function getPendingRun() {
  return collection().findOne({ status: 'awaiting_verdicts' });
}

async function savePendingRun(claims, uploadedBy) {
  await collection().deleteMany({}); // only one pending run at a time
  return collection().insertOne({
    status: 'awaiting_verdicts',
    claims,
    uploadedBy,
    uploadedAt: new Date(),
  });
}

async function clearPendingRun() {
  return collection().deleteMany({});
}

module.exports = { getPendingRun, savePendingRun, clearPendingRun };