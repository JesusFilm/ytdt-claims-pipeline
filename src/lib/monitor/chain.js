const { getBigQueryClient, tableRef } = require('../bigquery');

// Airbyte stamps every row it writes, so the warehouse is its own run log. The sync
// history lives on the Airbyte box, reachable only from there, and this is the same
// answer without a second credential to hold.
//
// stale_after is how long a stream may go quiet before that is worth seeing, read from
// the schedules in the connector's docs/connections.md. Retention is collected monthly
// and the MCN claims weekly, so silence there is normal and must not read as a fault.
const STREAMS = [
  { table: 'youtube_channel_videos', label: 'Channel videos', cadence: 'daily', stale_after: 48 },
  { table: 'youtube_video_views_by_day', label: 'Plays by day', cadence: 'daily', stale_after: 48 },
  { table: 'youtube_video_views_by_day_mcn', label: 'Plays by day, MCN', cadence: 'weekly', stale_after: 192 },
  { table: 'youtube_retention', label: 'Retention', cadence: 'monthly', stale_after: 792 },
  { table: 'youtube_public_videos', label: 'Public videos', cadence: 'daily', stale_after: 48 },
  { table: 'youtube_public_views_daily_snapshot', label: 'Public snapshots', cadence: 'daily', stale_after: 48 },
  { table: 'facebook_reels_metadata', label: 'Reels metadata', cadence: 'daily', stale_after: 48 },
  { table: 'facebook_reels_daily_snapshot', label: 'Reels snapshots', cadence: 'daily', stale_after: 48 },
  { table: 'facebook_posts_metadata', label: 'Posts metadata', cadence: 'daily', stale_after: 48 },
  { table: 'facebook_posts_daily_snapshot', label: 'Posts snapshots', cadence: 'daily', stale_after: 48 },
];

// Yesterday's count is there to be compared: a stream that ran but brought a fraction of
// its usual rows has not failed, and nothing else on the page would show it.
const LEG = (s) => `
  SELECT '${s.table}' AS table_name,
         COUNTIF(_airbyte_extracted_at > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)) AS rows_today,
         COUNTIF(_airbyte_extracted_at <= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
             AND _airbyte_extracted_at > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 48 HOUR)) AS rows_yesterday,
         MAX(_airbyte_extracted_at) AS last_run
  FROM ${tableRef(s.table)}
  WHERE _airbyte_extracted_at > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 60 DAY)`;

const CHAIN_SQL = STREAMS.map(LEG).join('\n  UNION ALL\n');

async function getChain() {
  const [rows] = await getBigQueryClient().query({ query: CHAIN_SQL, location: 'US' });
  const byTable = new Map(rows.map((r) => [r.table_name, r]));

  const streams = STREAMS.map((s) => {
    const r = byTable.get(s.table) || {};
    const last = r.last_run ? new Date(r.last_run.value) : null;
    const quiet_hours = last ? Math.floor((Date.now() - last.getTime()) / 3600000) : null;

    return {
      table: s.table,
      label: s.label,
      cadence: s.cadence,
      rows_today: r.rows_today || 0,
      rows_yesterday: r.rows_yesterday || 0,
      last_run: last ? last.toISOString() : null,
      quiet_hours,
      stale: quiet_hours === null || quiet_hours > s.stale_after,
    };
  });

  return { streams, stale_count: streams.filter((s) => s.stale).length };
}

module.exports = { getChain };
