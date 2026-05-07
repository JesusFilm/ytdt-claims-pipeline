#!/usr/bin/env node
/**
 * Backfill `short` column on historical youtube_mcn_claims rows.
 *
 * Queries claims where short = 0 within a date range (claim_last_updated_date),
 * runs the same HEAD-request check used by enrich-shorts.js,
 * and bulk-updates short = 1 for confirmed Shorts.
 *
 * Usage (run on GCP VM — MySQL reachable via VPN):
 *   node scripts/backfill-shorts.js --start=2010-01-01 --end=2024-12-31
 *   node scripts/backfill-shorts.js --start=2026-04-01 --end=2026-04-30 --dry-run
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const isShortVideo = require('../src/lib/isShortVideo');
const { mapWithConcurrency } = require('../src/lib/utils');

const SHORT_MAX_DURATION_SEC = 180;
const CONCURRENCY = 5;
const UPDATE_BATCH = 500;

const DRY_RUN = process.argv.includes('--dry-run');
const START = process.argv.find((a) => a.startsWith('--start='))?.split('=')[1];
const END = process.argv.find((a) => a.startsWith('--end='))?.split('=')[1] || new Date().toISOString().slice(0, 10);


if (!START) {
  console.error('Usage: node scripts/backfill-shorts.js --start=YYYY-MM-DD [--end=YYYY-MM-DD] [--dry-run]');
  process.exit(1);
}

async function main() {
  const db = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
  });

  console.log('MySQL connected');
  if (DRY_RUN) console.log('DRY RUN — no updates will be written');
  console.log(`Date range: ${START} → ${END}`);

  const [rows] = await db.query(
    `SELECT video_id, video_duration_sec FROM youtube_mcn_claims
     WHERE short = 0
       AND video_duration_sec > 0
       AND video_duration_sec <= ?
       AND claim_last_updated_date BETWEEN ? AND ?
     ORDER BY video_id`,
    [SHORT_MAX_DURATION_SEC, START, END]
  );

  console.log(`Total eligible rows (<= ${SHORT_MAX_DURATION_SEC}s, short=0): ${rows.length}`);
  if (!rows.length) {
    await db.end();
    return;
  }

  let checked = 0;
  const updates = await mapWithConcurrency(rows, CONCURRENCY, async (row) => {
    const short = (await isShortVideo(row.video_id)) ? 1 : 0;
    checked++;
    if (checked % 50 === 0) console.log(`  ${checked} / ${rows.length}`);
    console.log(`  ${row.video_id} (${row.video_duration_sec}s) -> short=${short}`);
    return { video_id: row.video_id, short };
  });

  const shorts = updates.filter((u) => u.short === 1).map((u) => u.video_id);

  if (shorts.length && !DRY_RUN) {
    for (let i = 0; i < shorts.length; i += UPDATE_BATCH) {
      const batch = shorts.slice(i, i + UPDATE_BATCH);
      const placeholders = batch.map(() => '?').join(',');
      await db.query(
        `UPDATE youtube_mcn_claims SET short = 1 WHERE video_id IN (${placeholders})`,
        batch
      );
    }
  } else if (shorts.length && DRY_RUN) {
    console.log(`[dry-run] would update ${shorts.length} rows as short=1`);
  }

  await db.end();
  console.log(`\nDone. Checked: ${rows.length}, marked short=1: ${shorts.length}`);
}

main().catch((err) => {
  console.error('backfill-shorts error:', err);
  process.exit(1);
});