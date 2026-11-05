const { getBigQueryClient, tableRef } = require('../bigquery');

const WINDOW_DAYS = 30;

// Today is still being collected, so the window ends yesterday.
const WINDOW = `
  WITH bounds AS (
    SELECT DATE_SUB(CURRENT_DATE(), INTERVAL ${WINDOW_DAYS} DAY) AS from_date,
           DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY) AS to_date
  )`;

// Days the source should have inside the window, counted from its own first day
// so a channel that started last week is not reported as 23 days behind.
const GAP_DAYS = `
  DATE_DIFF(b.to_date, GREATEST(b.from_date, p.first_day), DAY) + 1 - p.days_present`;

// Driven by the channel list, not by the data. A channel that collected nothing has no
// rows to be found by, and that is the one worth seeing.
const CHANNELS_SQL = `${WINDOW},
  expected AS (
    SELECT channel_id, channel_title AS title
    FROM ${tableRef('youtube_channels')}
    WHERE include_in_reporting = 1
  ),
  videos AS (
    SELECT channel_id,
           COUNT(DISTINCT video_id) AS videos
    FROM ${tableRef('youtube_channel_videos')}
    WHERE channel_id IS NOT NULL
    GROUP BY channel_id
  ),
  plays AS (
    SELECT v.channel_id,
           SUM(v.views) AS plays,
           COUNT(DISTINCT v.view_date) AS days_present,
           MIN(v.view_date) AS first_day,
           MAX(v.view_date) AS last_day
    FROM ${tableRef('youtube_video_views_by_day')} v, bounds b
    WHERE v.view_date BETWEEN b.from_date AND b.to_date
    GROUP BY v.channel_id
  )
  SELECT e.channel_id AS id,
         e.title,
         IFNULL(v.videos, 0) AS videos,
         IFNULL(p.plays, 0) AS plays,
         p.last_day,
         IFNULL(${GAP_DAYS}, ${WINDOW_DAYS}) AS gap_days,
         CAST(SAFE_DIVIDE(p.plays, p.days_present) * (${GAP_DAYS}) AS INT64) AS plays_missing
  FROM expected e
  LEFT JOIN videos v ON v.channel_id = e.channel_id
  LEFT JOIN plays p ON p.channel_id = e.channel_id
  CROSS JOIN bounds b
  ORDER BY plays DESC, videos DESC`;

const MCN_SQL = `${WINDOW},
  plays AS (
    SELECT m.content_owner_id,
           COUNT(DISTINCT m.video_id) AS videos,
           SUM(m.views) AS plays,
           COUNT(DISTINCT m.view_date) AS days_present,
           MIN(m.view_date) AS first_day,
           MAX(m.view_date) AS last_day
    FROM ${tableRef('youtube_video_views_by_day_mcn')} m, bounds b
    WHERE m.view_date BETWEEN b.from_date AND b.to_date
    GROUP BY m.content_owner_id
  )
  SELECT p.content_owner_id AS id,
         CASE p.content_owner_id
           WHEN 'J8g7R47ksUHF78DMrbZXYw' THEN 'Matter Entertainment'
           WHEN 'MjvkwLDytS3jM7M22BkMWg' THEN 'Matter 2'
           ELSE p.content_owner_id
         END AS title,
         p.videos,
         p.plays,
         p.last_day,
         ${GAP_DAYS} AS gap_days,
         CAST(SAFE_DIVIDE(p.plays, p.days_present) * (${GAP_DAYS}) AS INT64) AS plays_missing
  FROM plays p
  CROSS JOIN bounds b
  ORDER BY plays DESC`;

// Only a running total is stored, so plays over the window are the difference between
// the first and last snapshot of each video. A video seen only once contributes nothing.
const PUBLIC_SQL = `${WINDOW},
  snapshots AS (
    SELECT s.video_id,
           MIN(s.snapshot_date) AS first_day,
           MAX(s.snapshot_date) AS last_day,
           MIN_BY(s.lifetime_views, s.snapshot_date) AS first_views,
           MAX_BY(s.lifetime_views, s.snapshot_date) AS last_views
    FROM ${tableRef('youtube_public_views_daily_snapshot')} s, bounds b
    WHERE s.snapshot_date BETWEEN b.from_date AND b.to_date
    GROUP BY s.video_id
  ),
  coverage AS (
    SELECT COUNT(DISTINCT s.snapshot_date) AS days_present,
           MIN(s.snapshot_date) AS first_day,
           MAX(s.snapshot_date) AS last_day
    FROM ${tableRef('youtube_public_views_daily_snapshot')} s, bounds b
    WHERE s.snapshot_date BETWEEN b.from_date AND b.to_date
  )
  SELECT 'public' AS id,
         'tracking sheet' AS title,
         (SELECT COUNT(DISTINCT video_id) FROM ${tableRef('youtube_public_videos')}) AS videos,
         (SELECT IFNULL(SUM(last_views - first_views), 0) FROM snapshots) AS plays,
         c.last_day,
         DATE_DIFF(b.to_date, GREATEST(b.from_date, c.first_day), DAY) + 1 - c.days_present AS gap_days,
         CAST(NULL AS INT64) AS plays_missing
  FROM coverage c
  CROSS JOIN bounds b`;

async function runQuery(sql) {
  const [rows] = await getBigQueryClient().query({ query: sql, location: 'US' });
  return rows.map((r) => ({
    ...r,
    last_day: r.last_day ? r.last_day.value : null,
    gap_days: Math.max(0, r.gap_days || 0),
    plays_missing: r.plays_missing > 0 ? r.plays_missing : null,
  }));
}

function subtotal(rows) {
  return {
    videos: rows.reduce((a, r) => a + (r.videos || 0), 0),
    plays: rows.reduce((a, r) => a + (r.plays || 0), 0),
    gap_days: rows.reduce((a, r) => a + r.gap_days, 0),
    plays_missing: rows.reduce((a, r) => a + (r.plays_missing || 0), 0),
  };
}

// Channel and MCN totals are reported apart: MCN returns owned videos too, so adding
// them would double-count every video we both own and claim.
async function getVolume() {
  const [channels, mcn, pub] = await Promise.all([
    runQuery(CHANNELS_SQL),
    runQuery(MCN_SQL),
    runQuery(PUBLIC_SQL),
  ]);

  return {
    window_days: WINDOW_DAYS,
    groups: [
      { key: 'channels', label: 'Channels', rows: channels, total: subtotal(channels) },
      { key: 'mcn', label: 'MCN', rows: mcn, total: subtotal(mcn) },
      { key: 'public', label: 'Public', rows: pub, total: subtotal(pub) },
    ],
  };
}

module.exports = { getVolume, WINDOW_DAYS };
