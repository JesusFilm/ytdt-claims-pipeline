/*
 * Delete pipeline_runs from MongoDB by ID.
 * Usage: node scripts/delete-runs.js <runId> [<runId>...]
 * requires MONGODB_URI env var with connection string to the database
 */
require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');

const ids = process.argv.slice(2);
if (!ids.length) {
  console.error('Usage: node scripts/delete-runs.js <runId> [<runId>...]');
  process.exit(1);
}

(async () => {
  const client = await MongoClient.connect(process.env.MONGODB_URI);
  const result = await client.db().collection('pipeline_runs').deleteMany({
    _id: { $in: ids.map(id => new ObjectId(id)) }
  });
  console.log(`Deleted ${result.deletedCount} / ${ids.length} runs`);
  await client.close();
})();