const path = require('path');
const { google } = require('googleapis');
const { readCsv } = require('./utils');


// Reference CSVs (same files YT-Validator/pipeline.py reads from cwd).
// Override via env if they live elsewhere.
const LICENSED_CSV = process.env.LICENSED_CSV || path.join(process.cwd(), 'data', 'Licensed.csv');
const ASSETS_MEDIA_CSV = process.env.ASSETS_MEDIA_CSV || path.join(process.cwd(), 'data', 'assets_single_media_component.csv');


// YouTube ids may begin with '-'; spreadsheets prefix such cells with an
// apostrophe so they are not read as formulas, and it survives into the export.
// Sent to the API verbatim the id never matches, so the video is reported
// missing — 107 of 4,538 rows in the July 2026 batch, every one of them flagged
// unavailable against a 12% baseline.
const normalizeVideoId = (value) => String(value).trim().replace(/^'+/, '');

const OUTAGE_GIVE_UP = 3; // consecutive single-id failures meaning "API is down"

// Ask YouTube which of these ids exist. null means the call kept failing.
async function lookupIds(youtube, ids, retries) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const resp = await youtube.videos.list({ part: 'id', id: ids.join(',') });
      return new Set((resp.data.items || []).map(it => it.id));
    } catch (e) {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 2 ** attempt * 1000));
      } else {
        console.error(`Availability lookup failed for ${ids.length} id(s): ${e.message}`);
      }
    }
  }
  return null;
}

// Port of check_videos_available_batch() — batches of 50 (API limit).
// Returns id -> true (present) / false (missing) / null (unknown). Callers must
// treat null as unknown, never as unavailable: a failed lookup is not evidence
// about the video, and marking it so auto-rejects a valid claim.
async function checkVideosAvailableBatch(videoIds, retries = 2) {
  const results = {};
  const batchSize = 50; //  50 ids per request = 1 quota unit

  if (!process.env.YT_API_KEY) {
    throw new Error('YT_API_KEY is required to check video availability');
  }

  const youtube = google.youtube({ version: 'v3', auth: process.env.YT_API_KEY });
  const unique = [...new Set(videoIds.filter(Boolean))];

  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    const lookup = new Map(batch.map(id => [normalizeVideoId(id), id]));

    const found = await lookupIds(youtube, [...lookup.keys()], retries);
    if (found) {
      for (const [clean, original] of lookup) results[original] = found.has(clean);
      continue;
    }

    // The batch call kept failing. Retry the ids one at a time so a single
    // unacceptable id cannot condemn the other 49; give up once several in a
    // row fail, which means the API is down rather than an id being bad.
    let consecutiveFailures = 0;
    for (const [clean, original] of lookup) {
      if (consecutiveFailures >= OUTAGE_GIVE_UP) {
        results[original] = null;
        continue;
      }
      const one = await lookupIds(youtube, [clean], 0);
      if (one === null) {
        consecutiveFailures += 1;
        results[original] = null;
      } else {
        consecutiveFailures = 0;
        results[original] = one.has(clean);
      }
    }
  }
  return results;
}

/**
 * Mutates `rows` (array of plain string-keyed objects from the export_unprocessed_claims view),
 * adding the three columns that YT-Validator/pipeline.py used to add:
 *   - licensed            (True/False)
 *   - media_component_id  (mapped value or '')
 *   - video_available     (True/False; default True when no video_id)
 *
 * options.skipAvailability omits video_available and makes no YouTube Data API
 * calls. The other two columns are joins against local CSVs and cost nothing,
 * so the daily claims ingest takes them and leaves the quota alone. The column
 * is omitted rather than blanked: a blank means "lookup failed, route to
 * review", which is not what happened.
 */
async function enrichUnprocessedClaims(rows, { skipAvailability = false } = {}) {
  if (!rows.length) return rows;

  // licensed: df['asset_id'].isin(licensed_asset_ids)
  const licensedData = readCsv(LICENSED_CSV);
  const licensedAssetIds = new Set(
    (licensedData || [])
      .map(r => r.asset_id)
      .filter(v => v !== undefined && v !== null && String(v).trim() !== '')
      .map(String)
  );

  // media_component_id: df['asset_id'].map(asset_to_media_component)
  const assetsMediaData = readCsv(ASSETS_MEDIA_CSV);
  const assetToMediaComponent = new Map((assetsMediaData || []).map(r => [String(r.asset_id), r.media_component_id]));

  // video_available
  let availableMap = {};
  const hasVideoId = Object.prototype.hasOwnProperty.call(rows[0], 'video_id');
  if (hasVideoId && !skipAvailability) { availableMap = await checkVideosAvailableBatch(rows.map(r => r.video_id)); }

  for (const row of rows) {
    const assetId = String(row.asset_id);
    row.licensed = licensedAssetIds.has(assetId) ? 'True' : 'False';
    const mc = assetToMediaComponent.get(assetId);
    row.media_component_id = mc === undefined || mc === null ? '' : String(mc);

    if (skipAvailability) {
      continue;
    }

    if (hasVideoId) {
      const available = availableMap[row.video_id];
      // '' when the lookup could not determine it: pipeline.py reads a blank as
      // unknown and routes the claim to review rather than auto-rejecting it.
      row.video_available = available === null || available === undefined
        ? '' : (available ? 'True' : 'False');
    } else {
      row.video_available = 'True';
    }
  }

  return rows;
}

module.exports = enrichUnprocessedClaims;
