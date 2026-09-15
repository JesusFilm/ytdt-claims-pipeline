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
connect VPN → validate_input_csvs → process_claims (per owner) → enrich_shorts
   ↓
export export_unprocessed_claims only  (data/exports/claims-ingest/<ts>/)
   ↓
POST ML_API_ENDPOINT/asr/queue  (multipart `file`)
```

It is not a pipeline run: no `/predict`, no Drive upload, no Slack, no `pipeline_runs` record.
It makes **no YouTube Data API calls**: the unprocessed export skips `enrichUnprocessedClaims`
(its availability lookup spends the production API key's quota), which `/asr/queue` does not need.
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
