/**
 * Mirror jfp_analytics_prod.youtube_mcn_claims (MySQL / arclight, source of truth) -> BigQuery.
 *
 * Interim bridge only. The Airbyte YouTube connector reads the MCN video list from BigQuery
 * (`youtube_mcn_claims`, filtered by its claims_filter), so while claims live in MySQL the two
 * have to be kept in step. Once feat/export-views-bigquery lands, process-claims.js writes
 * BigQuery directly and this job should be DELETED, not maintained.
 *
 * COLUMN OWNERSHIP — the contract this job exists to honour
 * --------------------------------------------------------
 *   MySQL-owned : everything except the columns below. Overwritten on every run.
 *                 Written here by process-claims.js (INSERT new), process-verdicts.js
 *                 (verdict, wave, media_component_id, language_id, no_code, is_edited)
 *                 and enrich-shorts.js (short).
 *   BQ-owned    : `available`. Written by the Airbyte connector
 *                 (source_social_analytics/bigquery.py mark_video_unavailable) when the
 *                 YouTube Analytics API leaks channel totals for a claimed video, or denies
 *                 it outright. MySQL never learns about those decisions, so a truncate-load
 *                 would resurrect every leaking video as available = 1, put it straight back
 *                 into the connector's claim list and re-leak channel totals into MCN plays.
 *                 The MCN row set would then move between runs and plays could never be
 *                 reconciled against the legacy pipeline.
 *
 * So: load MySQL into a staging table, then MERGE, carrying BQ-owned columns over on matched
 * rows and leaving them to the table DEFAULT on genuinely new claims.
 *
 * DELETION SEMANTICS: claims absent from MySQL are DELETED from BigQuery. MySQL is
 * authoritative for which claims exist; orphans would keep retired claims in the MCN row set
 * and drift plays upward. `available` is preserved only for claims MySQL still has.
 *
 * `new` has no writer in either system — it is set by hand when new media lands. It mirrors
 * from MySQL like any other column. If it ever starts being edited on the BigQuery side, add
 * it to BQ_OWNED_COLUMNS. Same for `short` / `is_edited` if a BQ-side writer appears. None of
 * the three affect plays.
 *
 * Env:
 *   MYSQL_HOST MYSQL_USER MYSQL_PASSWORD MYSQL_DATABASE   (same vars the pipeline uses)
 *   BQ_PROJECT_ID   default jfp-data-warehouse
 *   BQ_DATASET      must be the dataset the Airbyte connector reads (currently `airbyte`)
 *   BQ_KEY_FILE     default ./config/service-account-key.json
 *   CLAIMS_MIRROR_ENABLED   "true" to arm the scheduler
 *   CLAIMS_MIRROR_TIME_UTC  HH:MM, default 05:30 — must land BEFORE the Airbyte sync
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const mysql = require('mysql2/promise');
const { BigQuery } = require('@google-cloud/bigquery');

const TABLE = 'youtube_mcn_claims';

// Columns the Airbyte connector owns in BigQuery. Preserved on MERGE for claims MySQL still
// has; left to the table DEFAULT for claims seen here for the first time.
const BQ_OWNED_COLUMNS = ['available'];

// Natural key. MySQL youtube_mcn_claims is one row per video_id.
const MERGE_KEY = 'video_id';

let running = false;

function bqClient() {
  return new BigQuery({
    projectId: process.env.BQ_PROJECT_ID || 'jfp-data-warehouse',
    keyFilename: process.env.BQ_KEY_FILE || './config/service-account-key.json',
  });
}

function datasetId() {
  const dataset = process.env.BQ_DATASET;
  if (!dataset) {
    throw new Error('BQ_DATASET is not set — it must match the dataset Airbyte reads');
  }
  return dataset;
}

function tableRef(name) {
  return `\`${process.env.BQ_PROJECT_ID || 'jfp-data-warehouse'}.${datasetId()}.${name}\``;
}

/** Coerce a MySQL value to something BigQuery's JSON loader accepts. */
function jsonify(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return value;
}

/**
 * Dump MySQL to newline-delimited JSON, keeping only columns BigQuery has. Source-only
 * columns (the legacy `claimid`, say) are dropped rather than failing the load.
 *
 * Streamed row by row: the claims table is ~550k rows and holding it in memory would fight
 * the 8GB heap cap the server already runs against.
 */
async function dumpMysqlToNdjson(pool, ndjsonPath, columns) {
  const allowed = new Set(columns);
  const out = fs.createWriteStream(ndjsonPath, { encoding: 'utf8' });
  let rows = 0;

  const stream = pool.pool.query(`SELECT * FROM ${TABLE}`).stream();
  for await (const row of stream) {
    const clean = {};
    for (const [k, v] of Object.entries(row)) {
      if (!allowed.has(k)) continue;
      const jv = jsonify(v);
      if (jv !== null) clean[k] = jv;
    }
    if (!out.write(JSON.stringify(clean) + '\n')) {
      await new Promise((resolve) => out.once('drain', resolve));
    }
    rows += 1;
  }

  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  return rows;
}

/**
 * Truncate-load the dump into staging via a LOAD JOB, not streaming inserts.
 *
 * This matters: rows written by table.insert() sit in the streaming buffer and are not
 * reliably visible to DML, so a MERGE straight afterwards can silently see a partial source
 * and delete live claims under WHEN NOT MATCHED BY SOURCE. Load jobs are immediately
 * queryable. process-claims.js hits the same constraint and solves it with INSERT DML.
 */
async function loadStaging(bq, ndjsonPath, stagingName, schema) {
  const [job] = await bq
    .dataset(datasetId())
    .table(stagingName)
    .load(ndjsonPath, {
      schema: { fields: schema },
      sourceFormat: 'NEWLINE_DELIMITED_JSON',
      writeDisposition: 'WRITE_TRUNCATE',
      createDisposition: 'CREATE_IF_NEEDED',
    });

  const errors = job.status && job.status.errors;
  if (errors && errors.length) {
    throw new Error(`Staging load failed: ${JSON.stringify(errors.slice(0, 3))}`);
  }
}

/**
 * MERGE staging -> live. MySQL-owned columns are overwritten, BQ-owned ones are untouched on
 * matched rows and unset on inserts, and claims MySQL no longer has are deleted.
 */
async function mergeIntoLive(bq, stagingName, columns) {
  const mysqlCols = columns.filter((c) => !BQ_OWNED_COLUMNS.includes(c));
  if (!columns.includes(MERGE_KEY)) {
    throw new Error(`${TABLE} has no ${MERGE_KEY} column — cannot MERGE`);
  }

  const setClause = mysqlCols
    .filter((c) => c !== MERGE_KEY)
    .map((c) => `T.\`${c}\` = S.\`${c}\``)
    .join(',\n      ');

  const query = `
    MERGE ${tableRef(TABLE)} T
    USING ${tableRef(stagingName)} S
    ON T.\`${MERGE_KEY}\` = S.\`${MERGE_KEY}\`
    WHEN MATCHED THEN UPDATE SET
      ${setClause}
    WHEN NOT MATCHED THEN
      INSERT (${mysqlCols.map((c) => `\`${c}\``).join(', ')})
      VALUES (${mysqlCols.map((c) => `S.\`${c}\``).join(', ')})
    WHEN NOT MATCHED BY SOURCE THEN DELETE
  `;

  const [job] = await bq.createQueryJob({ query });
  await job.getQueryResults();
  const [metadata] = await job.getMetadata();
  return metadata.statistics.query.dmlStats || {};
}

async function runClaimsMirror({ trigger = 'manual' } = {}) {
  if (running) {
    console.log('Claims mirror already running, skipping');
    return null;
  }
  running = true;

  const bq = bqClient();
  const stagingName = `${TABLE}_staging`;
  const ndjsonPath = path.join(os.tmpdir(), `${TABLE}-${Date.now()}.ndjson`);
  let pool;
  let ok = false;

  try {
    // The live table is the single source of truth for the schema: staging is created from
    // it and the MySQL dump is filtered to its columns.
    const [liveMeta] = await bq.dataset(datasetId()).table(TABLE).getMetadata();
    const schema = liveMeta.schema.fields;
    const columns = schema.map((f) => f.name);

    pool = await mysql.createPool({
      host: process.env.MYSQL_HOST,
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
      waitForConnections: true,
      connectionLimit: 2,
    });

    const staged = await dumpMysqlToNdjson(pool, ndjsonPath, columns);
    console.log(`Extracted ${staged} rows from MySQL ${TABLE}`);
    if (!staged) {
      // An empty dump would delete every live claim under WHEN NOT MATCHED BY SOURCE.
      throw new Error('MySQL returned 0 claims — refusing to MERGE an empty source');
    }

    await loadStaging(bq, ndjsonPath, stagingName, schema);
    console.log(`Staged ${staged} rows into ${stagingName}`);

    const stats = await mergeIntoLive(bq, stagingName, columns);
    console.log(
      `Merged ${TABLE} (${trigger}): ${stats.insertedRowCount || 0} inserted, ` +
        `${stats.updatedRowCount || 0} updated, ${stats.deletedRowCount || 0} deleted ` +
        `(preserved: ${BQ_OWNED_COLUMNS.join(', ')})`
    );

    const [countRows] = await bq.query({
      query: `SELECT COUNT(*) AS n FROM ${tableRef(TABLE)}`,
    });
    const live = Number(countRows[0].n);
    if (live !== staged) {
      throw new Error(`Row mismatch after MERGE: MySQL=${staged} BigQuery=${live}`);
    }
    console.log('OK: row counts match');

    await bq.query({ query: `DROP TABLE IF EXISTS ${tableRef(stagingName)}` });
    ok = true;
    return { staged, ...stats };
  } finally {
    running = false;
    if (pool) await pool.end();
    if (ok) {
      fs.promises.unlink(ndjsonPath).catch(() => {});
    } else {
      console.error(`NDJSON kept for inspection: ${ndjsonPath}`);
      console.error(`Staging table kept for inspection: ${stagingName}`);
    }
  }
}

function msUntilUtc(hhmm, now = new Date()) {
  const [h, m] = hhmm.split(':').map(Number);
  const next = new Date(now);
  next.setUTCHours(h, m, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}

function startClaimsMirrorScheduler() {
  if (!['true', '1'].includes(process.env.CLAIMS_MIRROR_ENABLED)) {
    console.log('Claims mirror disabled: CLAIMS_MIRROR_ENABLED not set');
    return;
  }

  const time = process.env.CLAIMS_MIRROR_TIME_UTC || '05:30';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error(`CLAIMS_MIRROR_TIME_UTC must be HH:MM, got "${time}"`);
  }

  const scheduleNext = () => {
    const delay = msUntilUtc(time);
    console.log(`Next claims mirror at ${new Date(Date.now() + delay).toISOString()}`);
    setTimeout(async () => {
      try {
        await runClaimsMirror({ trigger: 'schedule' });
      } catch (error) {
        console.error('Claims mirror crashed:', error);
      }
      scheduleNext();
    }, delay);
  };
  scheduleNext();
}

module.exports = {
  TABLE,
  BQ_OWNED_COLUMNS,
  MERGE_KEY,
  runClaimsMirror,
  msUntilUtc,
  startClaimsMirrorScheduler,
};
