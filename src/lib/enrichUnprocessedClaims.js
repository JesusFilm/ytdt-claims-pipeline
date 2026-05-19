const path = require('path');
const { google } = require('googleapis');
const { readCsv } = require('./utils');


// Reference CSVs (same files YT-Validator/pipeline.py reads from cwd).
// Override via env if they live elsewhere.
const LICENSED_CSV = process.env.LICENSED_CSV || path.join(process.cwd(), 'data', 'Licensed.csv');
const ASSETS_MEDIA_CSV = process.env.ASSETS_MEDIA_CSV || path.join(process.cwd(), 'data', 'assets_single_media_component.csv');


// Port of check_videos_available_batch() — batches of 50 (API limit),
// whole batch marked unavailable on error.
async function checkVideosAvailableBatch(videoIds) {
  const results = {};
  const batchSize = 50; //  50 ids per request = 1 quota unit

  if (!process.env.YT_API_KEY) {
    throw new Error('YT_API_KEY is required to check video availability');
  }

  const youtube = google.youtube({ version: 'v3', auth: process.env.YT_API_KEY });
  const unique = [...new Set(videoIds.filter(Boolean))];
  
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    try {
      const resp = await youtube.videos.list({ part: 'id', id: batch.join(',') });
      const found = new Set((resp.data.items || []).map(it => it.id));
      for (const id of batch) results[id] = found.has(id);
    } catch (e) {
      for (const id of batch) results[id] = false;
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
 */
async function enrichUnprocessedClaims(rows) {
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
  if (hasVideoId) { availableMap = await checkVideosAvailableBatch(rows.map(r => r.video_id)); }

  for (const row of rows) {
    const assetId = String(row.asset_id);
    row.licensed = licensedAssetIds.has(assetId) ? 'True' : 'False';
    const mc = assetToMediaComponent.get(assetId);
    row.media_component_id = mc === undefined || mc === null ? '' : String(mc);

    if (hasVideoId) {
      row.video_available = availableMap[row.video_id] ? 'True' : 'False';
    } else {
      row.video_available = 'True';
    }
  }

  return rows;
}

module.exports = enrichUnprocessedClaims;
