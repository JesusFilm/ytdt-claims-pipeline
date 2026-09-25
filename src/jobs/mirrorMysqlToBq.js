/**
 * Mirror jfp_analytics_prod (MySQL / arclight, source of truth) -> BigQuery.
 *
 * Interim bridge only. The Airbyte YouTube connector and the jfp-dbt YouTube models both read
 * from BigQuery, so while these tables live in MySQL the two sides have to be kept in step.
 * Once feat/export-views-bigquery lands, process-claims.js writes BigQuery directly and the
 * claims half of this job should be DELETED, not maintained.
 *
 * TABLES
 * ------
 *   youtube_mcn_claims  MERGE   — the MCN video list the connector reads, filtered by its
 *                                 claims_filter. Has a BigQuery-owned column, so it cannot be
 *                                 truncate-loaded (see COLUMN OWNERSHIP).
 *   youtube_video_views_by_day_public,
 *   youtube_public_videos_stg
 *                       REPLACE — the public-videos leg of the JFM plays view. The deployed
 *                                 MySQL view unions owned-channel plays with public
 *                                 (non-owned) video plays; the copy in
 *                                 jfm_youtube_analytics/sql/views/ shows only the first leg
 *                                 and is stale. The second leg is 500 channels, 2.1M rows,
 *                                 36.2M plays — 5.48% of all-time legacy JFM. Neither table
 *                                 has an Airbyte stream.
 *   youtube_channels    REPLACE — carries include_in_reporting, which gates BOTH plays paths:
 *                                 bi_view_youtube_plays_date_country_jfm joins on it and
 *                                 ..._mcn excludes on it. dbt read it from a hand-maintained
 *                                 CSV seed, which was accurate (15 rows, 14 flagged, matching
 *                                 MySQL) but is a copy someone has to remember to update.
 *                                 Nothing on the BigQuery side writes it, so a truncate-load
 *                                 is correct and simpler than a MERGE.
 *
 * COLUMN OWNERSHIP — the contract the MERGE path exists to honour
 * --------------------------------------------------------------
 *   MySQL-owned : everything except the columns below. Overwritten on every run.
 *                 On youtube_mcn_claims, written here by process-claims.js (INSERT new),
 *                 process-verdicts.js (verdict, wave, media_component_id, language_id,
 *                 no_code, is_edited) and enrich-shorts.js (short).
 *   BQ-owned    : youtube_mcn_claims.available. Written by the Airbyte connector
 *                 (source_social_analytics/bigquery.py mark_video_unavailable) when the
 *                 YouTube Analytics API leaks channel totals for a claimed video, or denies
 *                 it outright. MySQL never learns about those decisions, so a truncate-load
 *                 would resurrect every leaking video as available = 1, put it straight back
 *                 into the connector's claim list and re-leak channel totals into MCN plays.
 *                 Against the live table that is ~20,600 claims, every run.
 *
 * DELETION SEMANTICS (MERGE path): rows absent from MySQL are DELETED from BigQuery. MySQL is
 * authoritative for which claims exist; orphans would keep retired claims in the MCN row set
 * and drift plays upward. BQ-owned columns are preserved only for rows MySQL still has.
 *
 * `new` has no writer in either system — it is set by hand when new media lands, and mirrors
 * from MySQL like any other column. If it ever starts being edited on the BigQuery side, add
 * it to that table's bqOwned list. Same for `short` / `is_edited`. None affect plays.
 *
 * Env:
 *   MYSQL_HOST MYSQL_USER MYSQL_PASSWORD MYSQL_DATABASE   (same vars the pipeline uses)
 *   BQ_PROJECT_ID   default jfp-data-warehouse
 *   BQ_DATASET      must be the dataset Airbyte and dbt read (currently `airbyte`)
 *   BQ_KEY_FILE     default ./config/service-account-key.json
 *   CLAIMS_MIRROR_ENABLED   "true" to arm the scheduler
 *   CLAIMS_MIRROR_TIME_UTC  HH:MM, default 03:00 — before the Airbyte sync, and clear of the
 *                           06:00 claims ingest: only one OpenVPN client can run at a time
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { BigQuery } = require('@google-cloud/bigquery');
const connectVPN = require('../steps/connect-vpn');
const disconnectVPN = require('../steps/disconnect-vpn');

/**
 * mode 'merge'   — preserves `bqOwned` columns; needs `key`. Use when BigQuery writes columns
 *                  MySQL does not know about.
 * mode 'replace' — plain truncate-load. Correct only when nothing on the BigQuery side writes
 *                  to the table.
 */
const TABLES = [
  { name: 'youtube_mcn_claims', mode: 'merge', key: 'video_id', bqOwned: ['available'] },
  { name: 'youtube_channels', mode: 'replace', bqOwned: [] },
  // Public (non-owned) videos: the second UNION ALL leg of the live
  // bi_view_youtube_plays_date_country_jfm view, worth 5.48% of all-time legacy JFM plays.
  // Neither table has an Airbyte stream, so the mirror is the only route into BigQuery.
  { name: 'youtube_video_views_by_day_public', mode: 'replace', bqOwned: [] },
  { name: 'youtube_public_videos_stg', mode: 'replace', bqOwned: [] },
];

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
    throw new Error('BQ_DATASET is not set — it must match the dataset Airbyte and dbt read');
  }
  return dataset;
}

function tableRef(name) {
  return `\`${process.env.BQ_PROJECT_ID || 'jfp-data-warehouse'}.${datasetId()}.${name}\``;
}

/** Coerce a MySQL value to something BigQuery's JSON loader accepts. */
function jsonify(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    // MySQL zero dates ('0000-00-00') arrive as an Invalid Date, and toISOString() throws
    // RangeError on those. Treat them as NULL, which is what they mean.
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return value;
}

/**
 * The live BigQuery table is the source of truth for the schema, so the dump can be filtered
 * to its columns and source-only columns (the legacy `claimid`, say) dropped rather than
 * failing the load.
 *
 * Returns null when the table does not exist yet: the first load then autodetects from the
 * data rather than relying on a hand-written DDL. jfm_youtube_analytics/sql/create_tables.sql
 * still describes youtube_channels as four columns, from before include_in_reporting,
 * is_jesus_net, third_party and channel_group_name were added — exactly the kind of stale DDL
 * that would silently drop the column this mirror exists to carry.
 */
async function liveSchema(bq, table) {
  try {
    const [meta] = await bq.dataset(datasetId()).table(table).getMetadata();
    return meta.schema.fields;
  } catch (error) {
    if (error.code === 404) return null;
    throw error;
  }
}

/**
 * Dump a MySQL table to newline-delimited JSON, streamed row by row: the claims table is
 * ~550k rows and holding it in memory would fight the 8GB heap cap the server runs against.
 *
 * `columns` null means "keep everything" (first load, schema autodetected).
 */
async function dumpMysqlToNdjson(pool, table, ndjsonPath, columns) {
  const allowed = columns ? new Set(columns) : null;
  const out = fs.createWriteStream(ndjsonPath, { encoding: 'utf8' });
  let rows = 0;

  const stream = pool.pool.query(`SELECT * FROM ${table}`).stream();
  for await (const row of stream) {
    const clean = {};
    for (const [k, v] of Object.entries(row)) {
      if (allowed && !allowed.has(k)) continue;
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
 * Truncate-load NDJSON into `target` via a LOAD JOB, not streaming inserts.
 *
 * This matters for the merge path: rows written by table.insert() sit in the streaming buffer
 * and are not reliably visible to DML, so a MERGE straight afterwards can silently see a
 * partial source and delete live rows under WHEN NOT MATCHED BY SOURCE. Load jobs are
 * immediately queryable. process-claims.js hits the same constraint on
 * feat/export-views-bigquery and solves it with INSERT DML.
 *
 * Load jobs are also atomic, which is what makes the replace path safe without staging.
 */
async function loadNdjson(bq, ndjsonPath, target, schema) {
  const options = {
    sourceFormat: 'NEWLINE_DELIMITED_JSON',
    writeDisposition: 'WRITE_TRUNCATE',
    createDisposition: 'CREATE_IF_NEEDED',
  };
  if (schema) options.schema = { fields: schema };
  else options.autodetect = true;

  const [job] = await bq.dataset(datasetId()).table(target).load(ndjsonPath, options);

  const errors = job.status && job.status.errors;
  if (errors && errors.length) {
    throw new Error(`Load into ${target} failed: ${JSON.stringify(errors.slice(0, 3))}`);
  }
}

/**
 * Report what a MERGE would do, without doing it.
 *
 * preserved_bq_owned is the number to read: rows whose BigQuery-owned flag the MERGE will
 * carry over, every one of which a truncate-load would reset to the column default.
 */
async function previewMerge(bq, spec, stagingName) {
  const live = tableRef(spec.name);
  const staging = tableRef(stagingName);
  const flag = spec.bqOwned[0];

  // Anti-joins rather than NOT EXISTS: BigQuery refuses correlated subqueries it cannot
  // de-correlate, and these run against CTE-shaped sources.
  const [rows] = await bq.query({
    query: `
      WITH src AS (SELECT DISTINCT ${spec.key} FROM ${staging}),
      dst AS (SELECT ${spec.key}${flag ? `, ${flag}` : ''} FROM ${live}),
      matched AS (SELECT d.* FROM dst d JOIN src s USING (${spec.key})),
      inserts AS (
        SELECT s.${spec.key} FROM src s
        LEFT JOIN dst d USING (${spec.key}) WHERE d.${spec.key} IS NULL
      ),
      deletes AS (
        SELECT d.* FROM dst d
        LEFT JOIN src s USING (${spec.key}) WHERE s.${spec.key} IS NULL
      )
      SELECT
        (SELECT COUNT(*) FROM src)     AS source_rows,
        (SELECT COUNT(*) FROM dst)     AS live_rows,
        (SELECT COUNT(*) FROM matched) AS would_update,
        (SELECT COUNT(*) FROM inserts) AS would_insert,
        (SELECT COUNT(*) FROM deletes) AS would_delete,
        ${flag ? `(SELECT COUNTIF(${flag} = 0) FROM matched)` : '0'} AS preserved_bq_owned,
        ${flag ? `(SELECT COUNTIF(${flag} = 0) FROM deletes)` : '0'} AS bq_owned_deleted
    `,
  });
  return rows[0];
}

/**
 * MERGE staging -> live. MySQL-owned columns are overwritten, BQ-owned ones are untouched on
 * matched rows and left to the column DEFAULT on inserts, and rows MySQL no longer has are
 * deleted.
 */
async function mergeIntoLive(bq, spec, stagingName, columns) {
  const mysqlCols = columns.filter((c) => !spec.bqOwned.includes(c));
  if (!columns.includes(spec.key)) {
    throw new Error(`${spec.name} has no ${spec.key} column — cannot MERGE`);
  }

  const setClause = mysqlCols
    .filter((c) => c !== spec.key)
    .map((c) => `T.\`${c}\` = S.\`${c}\``)
    .join(',\n      ');

  const query = `
    MERGE ${tableRef(spec.name)} T
    USING ${tableRef(stagingName)} S
    ON T.\`${spec.key}\` = S.\`${spec.key}\`
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

/** Truncate-load straight into the live table. Safe only when nothing in BigQuery writes it. */
async function mirrorReplace(bq, pool, spec, dryRun) {
  const schema = await liveSchema(bq, spec.name);
  const columns = schema ? schema.map((f) => f.name) : null;
  const ndjsonPath = path.join(os.tmpdir(), `${spec.name}-${Date.now()}.ndjson`);

  try {
    const rows = await dumpMysqlToNdjson(pool, spec.name, ndjsonPath, columns);
    console.log(`Extracted ${rows} rows from MySQL ${spec.name}`);
    if (!rows) throw new Error(`MySQL returned 0 rows for ${spec.name} — refusing to truncate`);

    if (dryRun) {
      const live = schema
        ? Number(
            (await bq.query({ query: `SELECT COUNT(*) AS n FROM ${tableRef(spec.name)}` }))[0][0].n
          )
        : 0;
      console.log(
        `DRY RUN ${spec.name} — no changes written.\n` +
          `  MySQL rows       : ${rows}\n` +
          `  BigQuery rows now: ${live}${schema ? '' : ' (table does not exist yet)'}\n` +
          `  would REPLACE the table wholesale`
      );
      return { table: spec.name, dryRun: true, source_rows: rows, live_rows: live };
    }

    await loadNdjson(bq, ndjsonPath, spec.name, schema);
    console.log(`Replaced ${spec.name}: ${rows} rows`);
    return { table: spec.name, rows };
  } finally {
    fs.promises.unlink(ndjsonPath).catch(() => {});
  }
}

/** Stage then MERGE, preserving this table's BigQuery-owned columns. */
async function mirrorMerge(bq, pool, spec, dryRun) {
  const schema = await liveSchema(bq, spec.name);
  if (!schema) {
    throw new Error(
      `${spec.name} does not exist in BigQuery. Create it first — ` +
        `config/schemas/${spec.name}.sql — so its BQ-owned columns have their DEFAULTs.`
    );
  }
  const columns = schema.map((f) => f.name);
  const stagingName = `${spec.name}_staging`;
  const ndjsonPath = path.join(os.tmpdir(), `${spec.name}-${Date.now()}.ndjson`);
  let ok = false;

  try {
    const staged = await dumpMysqlToNdjson(pool, spec.name, ndjsonPath, columns);
    console.log(`Extracted ${staged} rows from MySQL ${spec.name}`);
    if (!staged) {
      // An empty dump would delete every live row under WHEN NOT MATCHED BY SOURCE.
      throw new Error(`MySQL returned 0 rows for ${spec.name} — refusing to MERGE an empty source`);
    }

    await loadNdjson(bq, ndjsonPath, stagingName, schema);
    console.log(`Staged ${staged} rows into ${stagingName}`);

    if (dryRun) {
      const p = await previewMerge(bq, spec, stagingName);
      console.log(
        `DRY RUN ${spec.name} — no changes written.\n` +
          `  MySQL rows            : ${p.source_rows}\n` +
          `  BigQuery rows now     : ${p.live_rows}\n` +
          `  would UPDATE          : ${p.would_update}\n` +
          `  would INSERT          : ${p.would_insert}\n` +
          `  would DELETE          : ${p.would_delete}   <-- rows MySQL no longer has\n` +
          `  ${spec.bqOwned[0]}=0 preserved : ${p.preserved_bq_owned}   <-- would be reset by a truncate-load\n` +
          `  ${spec.bqOwned[0]}=0 deleted   : ${p.bq_owned_deleted}   <-- gone from MySQL, so dropped`
      );
      if (Number(p.would_delete) > Number(p.source_rows) * 0.1) {
        console.warn(
          `WARNING: the MERGE would delete more than 10% of ${spec.name}. Check the extract ` +
            `before running for real.`
        );
      }
      // Staging is left in place so the numbers above can be inspected.
      ok = true;
      return { table: spec.name, dryRun: true, ...p };
    }

    const stats = await mergeIntoLive(bq, spec, stagingName, columns);
    console.log(
      `Merged ${spec.name}: ${stats.insertedRowCount || 0} inserted, ` +
        `${stats.updatedRowCount || 0} updated, ${stats.deletedRowCount || 0} deleted ` +
        `(preserved: ${spec.bqOwned.join(', ')})`
    );

    const [countRows] = await bq.query({
      query: `SELECT COUNT(*) AS n FROM ${tableRef(spec.name)}`,
    });
    const live = Number(countRows[0].n);
    if (live !== staged) {
      throw new Error(`Row mismatch after MERGE: MySQL=${staged} BigQuery=${live}`);
    }
    console.log(`OK: ${spec.name} row counts match`);

    await bq.query({ query: `DROP TABLE IF EXISTS ${tableRef(stagingName)}` });
    ok = true;
    return { table: spec.name, staged, ...stats };
  } finally {
    if (ok && !dryRun) {
      fs.promises.unlink(ndjsonPath).catch(() => {});
    } else if (!ok) {
      console.error(`NDJSON kept for inspection: ${ndjsonPath}`);
      console.error(`Staging table kept for inspection: ${stagingName}`);
    }
  }
}

async function runMirror({ trigger = 'manual', dryRun = false, tables = null } = {}) {
  if (running) {
    console.log('Mirror already running, skipping');
    return null;
  }
  running = true;

  const bq = bqClient();
  const specs = tables ? TABLES.filter((t) => tables.includes(t.name)) : TABLES;
  // RDS is reachable only through the pipeline's OpenVPN tunnel; a direct pool times out.
  // connectVPN raises the tunnel (unless SKIP_VPN) and builds context.connections.mysql.
  // Only one OpenVPN client can run at a time, so this must not overlap a pipeline run.
  const context = { connections: {} };

  try {
    await connectVPN(context);
    const pool = context.connections.mysql;

    const results = [];
    for (const spec of specs) {
      // Sequential: a failure on one table must not leave a later one half-applied against a
      // source that was never validated.
      results.push(
        spec.mode === 'merge'
          ? await mirrorMerge(bq, pool, spec, dryRun)
          : await mirrorReplace(bq, pool, spec, dryRun)
      );
    }
    console.log(`Mirror complete (${trigger}${dryRun ? ', dry run' : ''})`);
    return results;
  } finally {
    running = false;
    // disconnectVPN closes the MySQL pool itself; ending it again throws and would mask
    // whatever real error sent us here.
    try { await disconnectVPN(context); } catch (e) { console.error('VPN teardown failed:', e.message); }
  }
}

function msUntilUtc(hhmm, now = new Date()) {
  const [h, m] = hhmm.split(':').map(Number);
  const next = new Date(now);
  next.setUTCHours(h, m, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}

function startMirrorScheduler() {
  if (!['true', '1'].includes(process.env.CLAIMS_MIRROR_ENABLED)) {
    console.log('MySQL -> BigQuery mirror disabled: CLAIMS_MIRROR_ENABLED not set');
    return;
  }

  const time = process.env.CLAIMS_MIRROR_TIME_UTC || '03:00';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error(`CLAIMS_MIRROR_TIME_UTC must be HH:MM, got "${time}"`);
  }

  const scheduleNext = () => {
    const delay = msUntilUtc(time);
    console.log(`Next MySQL -> BigQuery mirror at ${new Date(Date.now() + delay).toISOString()}`);
    setTimeout(async () => {
      try {
        await runMirror({ trigger: 'schedule' });
      } catch (error) {
        console.error('Mirror crashed:', error);
      }
      scheduleNext();
    }, delay);
  };
  scheduleNext();
}

module.exports = {
  TABLES,
  runMirror,
  previewMerge,
  msUntilUtc,
  startMirrorScheduler,
};
