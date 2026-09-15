const { getDatabase } = require('../database');
const { COLLECTION } = require('../jobs/claimsIngest');


// Recent daily claims ingest attempts. authRequired means YouTube rejected the
// stored sign-in on the latest attempt and someone has to re-authorize.
async function getClaimsIngestStatus(req, res) {
  try {
    const collection = getDatabase().collection(COLLECTION);
    const [recent, lastCompleted] = await Promise.all([
      collection.find({}).sort({ startedAt: -1 }).limit(10).toArray(),
      collection.findOne({ status: 'completed' }, { sort: { startedAt: -1 } })
    ]);
    const lastAttempt = recent.find(r => !['skipped', 'running'].includes(r.status));

    res.json({
      enabled: ['true', '1'].includes(process.env.CLAIMS_INGEST_ENABLED),
      authRequired: !!lastAttempt?.authRequired,
      lastCompleted,
      recent
    });
  } catch (error) {
    console.error('Claims ingest status error:', error);
    res.status(500).json({ error: 'Failed to fetch claims ingest status' });
  }
}

module.exports = { getClaimsIngestStatus };
