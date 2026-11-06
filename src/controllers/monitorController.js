const { getVolume } = require('../lib/monitor/volume');
const { getChain } = require('../lib/monitor/chain');

// BigQuery is billed per scan, so answers are held long enough that extra viewers
// cost nothing. A refresh with ?fresh=1 clears it.
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();

async function cached(key, fn, fresh) {
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit;

  const data = await fn();
  const entry = { data, at: Date.now() };
  cache.set(key, entry);
  return entry;
}

function panel(key, fn) {
  return async (req, res) => {
    try {
      const entry = await cached(key, fn, req.query.fresh === '1');
      res.json({
        ...entry.data,
        fetched_at: new Date(entry.at).toISOString(),
        cached: Date.now() - entry.at > 1000,
      });
    } catch (error) {
      console.error(`Monitor ${key} error:`, error);
      res.status(500).json({ error: `Failed to load ${key}` });
    }
  };
}

module.exports = {
  getVolumePanel: panel('volume', getVolume),
  getChainPanel: panel('chain', getChain),
};
