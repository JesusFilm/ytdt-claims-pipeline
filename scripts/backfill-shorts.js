#!/usr/bin/env node
/**
 * Backfill `short` column on historical youtube_mcn_claims rows.
 *
 * Queries claims where short = 0 within a date range (claim_last_updated_date),
 * runs the same HEAD-request check used by enrich-shorts.js,
 * and bulk-updates short = 1 for confirmed Shorts.
 *
 * Usage (run on GCP VM — MySQL reachable via VPN):
 *   node scripts/backfill-shorts.js --start=2026-04-01 --end=2026-04-30 --dry-run
 *   node scripts/backfill-shorts.js --start=2026-04-01 --end=2026-04-30 --debug
 *   node scripts/backfill-shorts.js --start=2010-01-01 --resume=Zzd1_OYT7jI --debug
 *   node scripts/backfill-shorts.js --start=2010-01-01 --dry-run
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const isShortVideo = require('../src/lib/isShortVideo');
const { mapWithConcurrency } = require('../src/lib/utils');

const SHORT_MAX_DURATION_SEC = 180;
const CONCURRENCY = 5;
const UPDATE_BATCH = 500;

const DRY_RUN = process.argv.includes('--dry-run');
const DEBUG = process.argv.includes('--debug') || DRY_RUN;
const START = process.argv.find((a) => a.startsWith('--start='))?.split('=')[1];
const END = process.argv.find((a) => a.startsWith('--end='))?.split('=')[1] || new Date().toISOString().slice(0, 10);
const RESUME = process.argv.find((a) => a.startsWith('--resume='))?.split('=')[1];


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

  if (!DRY_RUN && !RESUME) {
    const backupTable = `youtube_mcn_claims_bkup_shorts_${new Date().toISOString().slice(0, 10).replace(/-/g, '_')}`;
    await db.query(`CREATE TABLE IF NOT EXISTS \`${backupTable}\` AS SELECT * FROM youtube_mcn_claims`);
    console.log(`Backed up youtube_mcn_claims to ${backupTable}`);
  }
  if (DRY_RUN) console.log('DRY RUN — no updates will be written');
  if (RESUME) console.log(`Resuming from video_id: ${RESUME}`);

  console.log(`Date range: ${START} → ${END}`);
  const [rows] = await db.query(
    `SELECT video_id, video_duration_sec, claim_last_updated_date FROM youtube_mcn_claims
     WHERE short = 0
       AND video_duration_sec > 0
       AND video_duration_sec <= ?
       AND claim_last_updated_date BETWEEN ? AND ?
       ${RESUME ? 'AND video_id > ?' : ''}
     ORDER BY video_id`,
     RESUME ? [SHORT_MAX_DURATION_SEC, START, END, RESUME] : [SHORT_MAX_DURATION_SEC, START, END]
  );

  console.log(`Total eligible rows (<= ${SHORT_MAX_DURATION_SEC}s, short=0): ${rows.length}`);
  if (!rows.length) {
    await db.end();
    return;
  }

  let checked = 0;
  let totalMarked = 0;

  for (let i = 0; i < rows.length; i += UPDATE_BATCH) {
    const chunk = rows.slice(i, i + UPDATE_BATCH);
    const updates = await mapWithConcurrency(chunk, CONCURRENCY, async (row) => {
      const short = (await isShortVideo(row.video_id)) ? 1 : 0;
      checked++;
      if (checked % 100 === 0) console.log(`  progress: ${checked} / ${rows.length} | last video_id: ${row.video_id} | claim_date: ${row.claim_last_updated_date?.toISOString().slice(0,10)}`);
      if (DEBUG) console.log(`  ${row.video_id} (${row.video_duration_sec}s) -> short=${short}`);
      return { video_id: row.video_id, short };
    });

    const shorts = updates.filter((u) => u.short === 1).map((u) => u.video_id);
    if (shorts.length && !DRY_RUN) {
      const placeholders = shorts.map(() => '?').join(',');
      await db.query(`UPDATE youtube_mcn_claims SET short = 1 WHERE video_id IN (${placeholders})`, shorts);
      totalMarked += shorts.length;
      console.log(`  updated ${shorts.length} | total marked: ${totalMarked} | last video_id: ${chunk[chunk.length - 1].video_id}`);
    } else if (shorts.length && DRY_RUN) {
      console.log(`[dry-run] would update ${shorts.length} rows as short=1`);
    }
  }

  await db.end();
  console.log(`\nDone. Checked: ${rows.length}, marked short=1: ${totalMarked} (${(totalMarked / rows.length * 100).toFixed(1)}%)`);
}

main().catch((err) => {
  console.error('backfill-shorts error:', err);
  process.exit(1);
});