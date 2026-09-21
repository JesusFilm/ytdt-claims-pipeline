const { getDatabase } = require('../database');
const { COLLECTION } = require('../jobs/claimsIngest');
const { createAuthedClient } = require('../lib/authtedClient');
const { CLAIMS_OWNERS } = require('../lib/youtubeReporting');


// Each owner's latest ingested snapshot, which is not the same as the latest
// run: an ingest only fetches owners whose report is new, so on a day only
// Matter 2 publishes, the latest run says nothing about Matter Entertainment.
// Reading owners off that one run made them vanish from the console.
async function ownerSnapshots(collection) {
  return Promise.all(Object.keys(CLAIMS_OWNERS).map(async source => {
    const run = await collection.findOne(
      { status: 'completed', [`reports.${source}`]: { $exists: true } },
      { sort: { startedAt: -1 } }
    );
    const report = run?.reports?.[source];
    const counts = run?.results?.claimsProcessed?.[source];
    return {
      source,
      // never ingested is an answer too: keep the owner, say so
      snapshot: report?.startTime ? report.startTime.slice(0, 10) : null,
      publishedAt: report?.createTime || null,
      ingestedAt: run?.endedAt || null,
      new: counts?.new ?? null,
      total: counts?.total ?? null,
      ingestId: run?._id ? run._id.toString() : null
    };
  }));
}


// YT-Validator's /asr/status lives on localhost:3001, which the browser cannot
// reach, so the console reads it through here. Cached briefly: the console polls
// once a minute, and the numbers only move when the collector runs (08:15 UTC).
const COLLECTOR_CACHE_MS = 30000;
let collectorCache = { at: 0, value: null, fetchedAt: null };

async function fetchCollectorStatus() {
  if (!process.env.ML_API_ENDPOINT) return collectorCache;
  if (Date.now() - collectorCache.at < COLLECTOR_CACHE_MS) return collectorCache;

  try {
    // 2s and no retry: ingest status must answer even when that service is
    // restarting. A hung upstream stalling the console is worse than a gap.
    const client = await createAuthedClient(process.env.ML_API_ENDPOINT, { timeout: 2000 });
    const { data } = await client.get('/asr/status');
    collectorCache = { at: Date.now(), value: data, fetchedAt: new Date().toISOString() };
  } catch (error) {
    // Absent is a valid answer, but the causes differ: 404 means YT-Validator
    // predates the endpoint (expected until it ships), while a refused
    // connection or timeout means the service is down and worth noticing.
    const status = error.response?.status;
    console.log(status === 404
      ? 'collector status: /asr/status not deployed yet (404)'
      : `collector status unavailable: ${error.code || status || error.message}`);
    collectorCache = { at: Date.now(), value: null, fetchedAt: null };
  }
  return collectorCache;
}

// Recent daily claims ingest attempts. authRequired means YouTube rejected the
// stored sign-in on the latest attempt and someone has to re-authorize.
async function getClaimsIngestStatus(req, res) {
  try {
    const collection = getDatabase().collection(COLLECTION);
    const [recent, lastCompleted, owners, collector] = await Promise.all([
      collection.find({}).sort({ startedAt: -1 }).limit(10).toArray(),
      collection.findOne({ status: 'completed' }, { sort: { startedAt: -1 } }),
      ownerSnapshots(collection),
      fetchCollectorStatus()
    ]);
    const lastAttempt = recent.find(r => !['skipped', 'running'].includes(r.status));

    res.json({
      enabled: ['true', '1'].includes(process.env.CLAIMS_INGEST_ENABLED),
      authRequired: !!lastAttempt?.authRequired,
      lastCompleted,
      owners,
      recent,
      collector: collector.value,
      // when WE fetched it, distinct from collector.last_run (when it ran):
      // with a cache in between, those two staleness questions diverge
      collectorFetchedAt: collector.fetchedAt
    });
  } catch (error) {
    console.error('Claims ingest status error:', error);
    res.status(500).json({ error: 'Failed to fetch claims ingest status' });
  }
}

module.exports = { getClaimsIngestStatus, ownerSnapshots, fetchCollectorStatus };
