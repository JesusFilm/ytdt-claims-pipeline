-- Bootstrap DDL for the BigQuery youtube_mcn_claims table.
--
-- This is the table the Airbyte YouTube connector reads the MCN video list from
-- (source_social_analytics, filtered by its claims_filter), and the table
-- src/jobs/mirrorClaimsToBq.js MERGEs MySQL into. Run it once, by hand, into the
-- dataset the connector reads (BQ_DATASET, currently `airbyte`):
--
--   bq query --use_legacy_sql=false \
--     "$(sed 's|{table}|jfp-data-warehouse.airbyte.youtube_mcn_claims|' \
--        config/schemas/youtube_mcn_claims.sql)"
--
-- Mirrors the MySQL table plus short / is_edited / new. `available` DEFAULT 1 matters:
-- the mirror leaves that column alone on matched rows and to this default on inserts,
-- because the connector owns it. See BQ_OWNED_COLUMNS in src/jobs/mirrorClaimsToBq.js.
CREATE TABLE IF NOT EXISTS `{table}`
(
  claim_id STRING,
  claim_status STRING,
  claim_status_detail STRING,
  claim_origin STRING,
  claim_type STRING,
  asset_id STRING,
  video_id STRING NOT NULL,
  uploader STRING,
  channel_id STRING,
  channel_display_name STRING,
  video_title STRING,
  views INT64,
  matching_duration STRING,
  longest_match INT64,
  content_type STRING,
  reference_video_id STRING,
  reference_id STRING,
  claim_policy_id STRING,
  asset_policy_id STRING,
  claim_policy_monetize STRING,
  claim_policy_track STRING,
  claim_policy_block STRING,
  asset_policy_monetize STRING,
  asset_policy_track STRING,
  asset_policy_block STRING,
  claim_created_date STRING,
  video_upload_date STRING,
  custom_id STRING,
  video_duration_sec INT64,
  asset_title STRING,
  asset_labels STRING,
  tms STRING,
  director STRING,
  studio STRING,
  season STRING,
  episode_number STRING,
  episode_title STRING,
  release_date STRING,
  hfa_song_code STRING,
  isrc STRING,
  grid STRING,
  artist STRING,
  album STRING,
  record_label STRING,
  upc STRING,
  iswc STRING,
  writers STRING,
  duration STRING,
  duration_seconds INT64,
  verdict STRING NOT NULL,
  wave STRING NOT NULL,
  language_id STRING,
  media_component_id STRING,
  views_last_updated_date TIMESTAMP,
  claim_last_updated_date TIMESTAMP,
  verdict_last_updated_date TIMESTAMP,
  no_code STRING,
  claim_report_source STRING,
  engaged_views INT64,
  video_matching_length INT64,
  is_shorts_eligible STRING,
  available INT64 DEFAULT 1,
  short INT64 DEFAULT 0,
  is_edited INT64 DEFAULT 0,
  `new` INT64 DEFAULT 0
);
