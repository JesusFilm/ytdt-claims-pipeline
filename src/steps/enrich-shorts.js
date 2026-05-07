const isShortVideo = require('../lib/isShortVideo');
const { mapWithConcurrency } = require('../lib/utils');

const SHORT_MAX_DURATION_SEC = 180;
const CONCURRENCY = 5;


async function enrichShorts(context) {
  const mysql = context.connections.mysql;

  // Scope to rows inserted/updated today — insert_claims.rb sets
  // claim_last_updated_date = NOW() on every insert and ON DUPLICATE KEY UPDATE.
  const [rows] = await mysql.query(
    `SELECT video_id, video_duration_sec
     FROM youtube_mcn_claims
     WHERE short = 0
       AND video_duration_sec > 0
       AND video_duration_sec <= ?
       AND DATE(claim_last_updated_date) = CURDATE()`,
    [SHORT_MAX_DURATION_SEC]
  );

  if (!rows.length) {
    console.log('enrich_shorts: no eligible videos to check today');
    return;
  }

  console.log(`enrich_shorts: checking ${rows.length} candidates (<= ${SHORT_MAX_DURATION_SEC}s)`);

  let checked = 0;
  const updates = await mapWithConcurrency(rows, CONCURRENCY, async (row) => {
    const short = (await isShortVideo(row.video_id)) ? 1 : 0;
    checked++;
    if (checked % 50 === 0) console.log(`  ${checked} / ${rows.length}`);
    console.log(`  ${row.video_id} (${row.video_duration_sec}s) -> short=${short}`);
    return { video_id: row.video_id, short };
  });

  const shorts = updates.filter((u) => u.short === 1).map((u) => u.video_id);

  if (shorts.length) {
    const BATCH_SIZE = 500;
    for (let i = 0; i < shorts.length; i += BATCH_SIZE) {
      const batch = shorts.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => '?').join(',');
      await mysql.query(
        `UPDATE youtube_mcn_claims SET short = 1 WHERE video_id IN (${placeholders})`,
        batch
      );
    }
  }

  console.log(`enrich_shorts: marked ${shorts.length} / ${rows.length} as short=1`);

  context.outputs.enrichShorts = {
    checked: rows.length,
    marked: shorts.length,
  };
}

module.exports = enrichShorts;