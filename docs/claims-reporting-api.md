# Daily Claims Ingest — YouTube Reporting API

## Overview

The claims CSVs Data Engineering downloaded by hand from YouTube Studio ("Claims report Version 1.2") are the
system-managed Reporting API report `content_owner_active_claims_a3`, byte for byte (verified 2026-09-15 for both
owners). The server now fetches them daily and keeps `youtube_mcn_claims` current, then refreshes YT-Validator's
ASR caption queue.

```
06:00 UTC (CLAIMS_INGEST_TIME_UTC)
   ↓  skip if a pipeline run is active (retry next day)
Newest a3 report per owner not yet ingested  →  nothing new? record "nothing_new", stop
   ↓  download + gunzip  (data/claims-reports/, deleted after success)
connect_vpn (MySQL; no tunnel when SKIP_VPN) → validate_input_csvs → process_claims (per owner) → enrich_shorts
   ↓
export export_unprocessed_claims only  (data/exports/claims-ingest/<yyyyMMddHHmmss>/)
   ↓
POST ML_API_ENDPOINT/asr/queue  (multipart `file`)
```

It is not a pipeline run: no `/predict`, no Drive upload, no Slack, no `pipeline_runs` record.

It makes **no YouTube Data API calls**. The export runs the free half of `enrichUnprocessedClaims` —
`licensed` and `media_component_id`, both joins against local CSVs — and skips only the
`video_available` lookup, which spends the production API key's quota (`options.skipAvailability`).
`video_available` is omitted rather than blanked, because blank means "lookup failed, route to review".
`enrich_shorts` runs here because it only checks rows touched today (HEAD requests, no quota).

| Owner | Content owner ID | Studio name |
|---|---|---|
| matter_entertainment | J8g7R47ksUHF78DMrbZXYw | InklingCollective2 |
| matter_2 | MjvkwLDytS3jM7M22BkMWg | GabrielCommunicationsInc |

## Reports

- A new report lands ~62h after its data date; YouTube skips days (gaps of up to 20 days seen) and keeps ~60 days.
  The job takes the newest available report and does nothing when it has already been ingested.
- Each is a full snapshot (active, inactive, pending): Matter Entertainment ~1.48M rows / 850MB, Matter_2 ~384k / 250MB.
  `process-claims` filters to Jesus Film claims while streaming; the `video_id NOT IN` merge keeps it insert-only.
- `process-claims` staging tables `claim_report_<yyyyMMdd>_<source>` are kept (~700k rows/day across both owners).

## What YT-Validator receives

`unprocessed_claims.csv`, the `export_unprocessed_claims` view (~60 columns): `video_id`, `views`,
`channel_id`, `video_title`, `claim_status`, `media_component_id` and `licensed` (`True`/`False`).
No `video_available` and no `triage` — the collector orders by views and defers licensed rows
(~18% of lookups) to the tail rather than excluding them.

## Console timeline

The console's Collection tab (ytdt-claims-console) shows four steps. They are easy to conflate:

| Step | Means | Source |
|---|---|---|
| Published | YouTube generated the report and made it downloadable | `reports.<source>.createTime` |
| Ingested | Downloaded, filtered to Jesus Film claims, new rows merged into MySQL | ingest record `endedAt` |
| Queued | Unprocessed claims exported and posted to `/asr/queue` | `results.asrQueue.rows` |
| Scoring | YT-Validator's collector pulls captions and scores them | its collector (08:15 UTC) |

"Latest snapshot" is **not** Published: the snapshot date (`startTime`) is the day the data covers,
and publishing lags it ~62h. Showing both is what makes that lag visible.

Scoring currently always renders as pending — the console has no signal from the collector. Either
YT-Validator exposes queue-drain state, or the step should be dropped rather than shown permanently grey.

## Where BigQuery fits

MySQL `jfp_analytics_prod.youtube_mcn_claims` is the source of truth. Airbyte
(`source_social_analytics`) does **not** read it: it reads a BigQuery copy, `airbyte.youtube_mcn_claims`,
refreshed by `scripts/sync_mcn_claims_to_bq.py` in the connector repo (`SELECT *`, `WRITE_TRUNCATE`).
That copy is a bridge, and it belongs to the connector, not to this pipeline. It should run after an
ingest that loaded new claims, and skip otherwise.

Distinct from the `feat/export-views-bigquery` branch, which moves this pipeline's own reads and
writes to BigQuery. When that lands the pipeline writes BQ directly and the copy becomes unnecessary.

Terminology, since both get called "mirror": the **git mirror** is `ceduth/ytdt-claims-pipeline`
(see [deploy](./deploy.md)); the **BQ claims copy** is the table above.

## Export directories

`generateRunFolderName` (`EXPORT_FOLDER_NAME_FORMAT`) names the **Drive folder** and is unchanged.
Local directories use `runDirName` — `yyyyMMddHHmmss` — because the production format
(`MMM d yyyy hh:mm:ss a`) puts spaces and colons in paths: colons make `scp`/`rsync`/`gcloud` read
`host:path`, both are illegal on Windows, and the name does not sort. `resolveRunExportDir` prefers
the safe directory and falls back to the legacy label directory when that is what exists on disk,
so exports from earlier runs stay downloadable. No migration was needed.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CLAIMS_INGEST_ENABLED` | off | `true` to schedule the daily job |
| `CLAIMS_INGEST_TIME_UTC` | `06:00` | Daily run time, HH:MM UTC (YT-Validator's collector runs 08:15) |
| `YT_REPORTING_TOKEN_FILE` | — | Authorized-user token JSON (refresh_token, client_id, client_secret), mode 0600 |
| `YT_REPORTING_CLIENT_FILE` | — | Desktop OAuth client JSON, only if the token file lacks client_id/secret |
| `YT_OWNER_MATTER_ENTERTAINMENT` / `YT_OWNER_MATTER_2` | IDs above | Content owner overrides |
| `CLAIMS_REPORT_DIR` | `data/claims-reports` | Download location |
| `ML_API_ENDPOINT` | — | YT-Validator base URL (existing) |

Keep token and client files under `config/` (gitignored).

## Credentials

A service account cannot read content-owner reports (HTTP 403). The job uses a user refresh token for a
content-manager account (media@jesusfilm.org), scope `yt-analytics.readonly`, from a **Desktop app** OAuth
client in `jfp-data-warehouse`.

```bash
YT_REPORTING_LOGIN_HINT=media@jesusfilm.org \
  node scripts/youtube-reporting-auth.js config/youtube-reporting-client.json config/youtube-reporting-token.json
```

Open the printed URL in the browser profile signed in as that account. A token file from the Python
experiment (`google-auth` `token.json`) works as is.

The token file is read on every run, so replacing it needs no server restart.

### When Google asks for sign-in again

While the consent screen is in **Testing**, refresh tokens expire after 7 days. Published, a token has no fixed
lifetime but still stops working when:

- the account's access is revoked (by the user or a Workspace admin), or it loses access to the content owner;
- it goes unused for 6 months (the daily job prevents this);
- more than 100 tokens exist for the same account and client (each new sign-in pushes out the oldest);
- a Workspace admin restricts YouTube services or sets a session length.

The job treats `invalid_grant`, `invalid_client`, 401/403 and a missing token file, raised while listing or
downloading reports, as **re-authorization required**:

- the attempt is recorded as `failed` with `authRequired: true` and the fix in `error`;
- one Slack message goes to `SLACK_CHANNEL` when this starts (not on every daily retry), if `SLACK_BOT_TOKEN` is set;
- `GET /api/claims-ingest/status` returns `authRequired: true` until an attempt succeeds.

To fix, run the sign-in script above on the VM, writing over `YT_REPORTING_TOKEN_FILE`, then
`node scripts/ingest-claims-report.js` or wait for the next scheduled run.

## Running and monitoring

```bash
node scripts/ingest-claims-report.js --dry-run
node scripts/ingest-claims-report.js
```

Every attempt is a document in MongoDB `claims_report_ingestions`:
`status` (`completed`, `nothing_new`, `skipped`, `failed`, `running`), `trigger` (`schedule` | `manual`),
`reports.<source>` (reportId, startTime, createTime), `results` (claimsProcessed counts, enrichShorts,
asrQueue response), `error` and `authRequired`.

`GET /api/claims-ingest/status` (authenticated) returns `enabled`, `authRequired`, `lastCompleted` and the 10 most
recent attempts.

While an ingest is running, `POST /api/run`, Slack runs and retries return "claims ingest running".

## Monthly `/predict` retraining fields

`enrich_ml` also sends, when available:

- `language_history` — absolute path of the run's `all_claims.csv` export
- `language_eval_labels` — absolute path of each verdict upload (MCN, JFM), once per file

YT-Validator retrains its language model from them (~15 min) and keeps the previous model when they are missing.
