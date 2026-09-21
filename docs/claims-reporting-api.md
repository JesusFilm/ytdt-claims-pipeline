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

It is not a pipeline run: no `/predict`, no Drive upload, no `pipeline_runs` record. The only Slack it
sends is the `claims-ingest` alert when a run fails (see [slack-integration](./slack-integration.md)).

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
| Audio language | YT-Validator's collector records the language YouTube's speech recognition heard | `collector.*` (its 08:15 UTC run) |

"Latest snapshot" is **not** Published: the snapshot date (`startTime`) is the day the data covers,
and publishing lags it ~62h. Showing both is what makes that lag visible.

**Audio language is where a report's lifecycle ends.** Despite the internal name "ASR queue", no
caption is fetched and nothing is transcribed. The collector calls `captions.list(part=snippet)`,
which returns track *metadata*, keeps only tracks with `trackKind == "asr"` (YouTube's own
machine-generated ones, ignoring human tracks), and stores one BCP-47 code per video, e.g. `ru`.
180 videos a day, bounded by quota. Nothing is decided and no column is written for Ben.

A video with no usable auto-caption track is stored as `""` — which covers three different causes:
no ASR track at all, captions present but forbidden (403), or the video gone (404). Don't render
that as "no captions"; it means "no usable audio language". A `""` is a real answer and is cached,
so the video is never paid for twice.

Verdicts and languages are a *separate monthly lifecycle*, driven by Ben's verdict sheets through
one `/predict` call: the verdict model produces rating, predicted_verdict, confidence and triage
(AUTO_Y, REVIEW, AUTO_N, AUTO_N_LICENSED, AUTO_N_UNAVAILABLE, AUTO_N_CHANNEL), then the language
cascade produces predicted_language_id/name, language_source (CHANNEL, TITLE, ASR, FASTTEXT, LID,
REVIEW) and language_confidence. The daily evidence is an *input* to that cascade; the ISO→WESS
mapping and language certification happen there, never in the daily run.

So a per-report timeline stops at audio language. Showing verdict/language scoring there would sit pending
for weeks, because it does not happen per report.

`collector` in `GET /api/claims-ingest/status` proxies YT-Validator's `/asr/status`, which the browser
cannot reach on localhost:3001. Cached 30s, 2s timeout, no retry — ingest status must answer even when
that service is restarting. It is `null` when YT-Validator predates the endpoint (404), is restarting
or is down; the console reads absent as "not started", not an error. `collectorFetchedAt` says when
*we* fetched it, which with a cache in between is a different question from `collector.last_run`.

Its blocks (`queue`, `cache`, `collector`, `languages`, `version`) are empty objects before the first
run, not nulls. `collector.remaining` is as of the last run, not live — recomputing it per request
would mean re-applying the model's rules over the whole queue. `collector.stopped_reason` is `null`
normally, `quota` when the daily key ran out mid-run, `outage` after repeated failures; either way the
run ended early. `queue.has_licensed` says whether the current queue came from an export carrying the
`licensed` column.

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
| `ML_API_ENDPOINT` | — | YT-Validator base URL (existing); also enables the collector watch |
| `COLLECTOR_WATCH_TIME_UTC` | `08:45` | Daily check of YT-Validator's collector, after its 08:15 run |
| `COLLECTOR_STALE_HOURS` | `26` | Age of the collector's last run that counts as "did not run" |

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
- one Slack message goes to `SLACK_CHANNEL` when this starts, not on every daily retry, if `SLACK_BOT_TOKEN`
  is set — and its wording depends on the cause, since a Workspace block needs an admin rather than a sign-in;
- `GET /api/claims-ingest/status` returns `authRequired: true` until an attempt succeeds.

#### Re-authorizing (about 5 minutes)

Do this from a **laptop**, not the VM. The script listens on `127.0.0.1` for Google's redirect, so it must run
where the browser is — on the VM the sign-in completes in your browser and the VM never hears back.

You need: a checkout of this repo with `yarn install` done, the Desktop OAuth client JSON from
`jfp-data-warehouse` used for the first sign-in (keep it somewhere safe), a Chrome profile signed in as
media@jesusfilm.org, and `gcloud` access to the VM.

1. Sign in and write a fresh token locally. Open the printed URL in the media@ profile and approve:

   ```bash
   YT_REPORTING_LOGIN_HINT=media@jesusfilm.org \
     node scripts/youtube-reporting-auth.js youtube-reporting-client.json youtube-reporting-token.json
   ```

2. Pipe it into place on the VM. Piping, rather than `gcloud compute scp` via `/tmp`, means the token never
   sits readable by other users; it lands root-owned, mode 0600:

   ```bash
   gcloud compute ssh ytdt-claims --zone us-east1-b \
     --command "sudo sh -c 'umask 077; cat > /opt/ytdt-claims-pipeline/config/youtube-reporting-token.json'" \
     < youtube-reporting-token.json
   ```

3. Delete the local copy — it is a long-lived credential for the content owner:

   ```bash
   rm youtube-reporting-token.json
   ```

The token is read on every run, so no restart is needed. The next scheduled run (06:00 UTC) succeeds and clears
`authRequired`; to collect sooner, run `node scripts/ingest-claims-report.js` on the VM.

Signing in again pushes out the oldest token for this account and client once there are 100, so avoid repeated
sign-ins "to be safe".

#### Planned: reconnect from the console

Not built; recorded here because issues are disabled on this repo. Worth it only if re-authorization turns out to
be more than rare. A "Reconnect YouTube" button beside the console's *Sign-in expired* banner:

- **Client:** a Web OAuth client with a redirect URI on this API. Desktop clients cannot redirect to a server.
  Confirm `yt-analytics.readonly` is already approved on that client's consent screen, or it needs another
  verification round.
- **Start:** only from a signed-in console session, with `login_hint=media@jesusfilm.org`, `prompt=consent`,
  `access_type=offline`, and a single-use `state` bound to that session so the callback cannot be forged or replayed.
- **Before saving:** require the Google account to be media@jesusfilm.org, and make one Reporting API call on
  behalf of each content owner. A sign-in with the wrong account must not overwrite a working token.
- **Finish:** write the token file atomically (0600), clear the alert, and offer "Run ingest now".

Roughly a day, pipeline and console together.

## Running and monitoring

```bash
node scripts/ingest-claims-report.js --dry-run
node scripts/ingest-claims-report.js
```

Every attempt is a document in MongoDB `claims_report_ingestions`:
`status` (`completed`, `nothing_new`, `skipped`, `failed`, `running`), `trigger` (`schedule` | `manual`),
`reports.<source>` (reportId, startTime, createTime), `results` (claimsProcessed counts, enrichShorts,
asrQueue response), `error` and `authRequired`.

`GET /api/claims-ingest/status` (authenticated) returns `enabled`, `authRequired`, `lastCompleted`, `owners` and the
10 most recent attempts.

`owners` has one entry per content owner — `snapshot` (data date), `publishedAt`, `ingestedAt`, `new`, `total`,
`ingestId` — taken from the newest completed ingest that included *that owner's* report. This is not the same as
`lastCompleted`: an ingest only fetches owners with a new report, so on a day only Matter 2 publishes, the latest run
carries no Matter Entertainment at all. An owner never ingested is still listed, with `snapshot: null`.

`GET /api/runs/history` returns ingests alongside pipeline runs, since the ingest is now what brings claims in and
history without it is incomplete. `runs` carry `kind: "pipeline"` and a `mode` — `full`, `scoring` (a steps-filtered
run that imported nothing) or `partial` — and `ingests` carry `kind: "ingest"` with report ids, counts and the
`/asr/queue` response, but never the signed `downloadUrl`. `?limit` (default 20, max 100), `?before=<ISO>` pages back
through both collections on one cursor, and `?kind=pipeline|ingest` narrows. `stats.medianDuration` is split by mode,
because a scoring run takes minutes and a full run tens of minutes.

While an ingest is running, `POST /api/run`, Slack runs and retries return "claims ingest running".

## Monthly `/predict` retraining fields

`enrich_ml` also sends, when available:

- `language_history` — absolute path of the run's `all_claims.csv` export
- `language_eval_labels` — absolute path of each verdict upload (MCN, JFM), once per file

YT-Validator retrains its language model from them (~15 min) and keeps the previous model when they are missing.
