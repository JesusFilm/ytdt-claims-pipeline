const fs = require('fs').promises;
const csv = require('csv-parse/sync');

// Columns that currently exist in MySQL tables
const VALID_COLUMNS = {
  claims: [
    'claim_id', 'claim_status', 'claim_status_detail', 'claim_origin', 'claim_type',
    'asset_id', 'video_id', 'uploader', 'channel_id', 'channel_display_name',
    'video_title', 'views', 'matching_duration', 'longest_match', 'content_type',
    'reference_video_id', 'reference_id', 'claim_policy_id', 'asset_policy_id',
    'claim_policy_monetize', 'claim_policy_track', 'claim_policy_block',
    'asset_policy_monetize', 'asset_policy_track', 'asset_policy_block',
    'claim_created_date', 'video_upload_date', 'custom_id', 'video_duration_sec',
    'asset_title', 'asset_labels', 'tms', 'director', 'studio', 'season',
    'episode_number', 'episode_title', 'release_date', 'hfa_song_code',
    'isrc', 'grid', 'artist', 'album', 'record_label', 'upc', 'iswc', 'writers'
  ],
  mcnVerdicts: [
    'video_id', 'verdict', 'media_component_id', 'language_id', 'wave', 'no_code'
  ],
  jfmVerdicts: [
    'video_id', 'verdict', 'media_component_id', 'language_id', 'wave', 'no_code'
  ]
};

// Handle column normalization from process-claims.js
function normalizeClaimsColumns(row) {
  if (row['REPLACE(channel_display_name, ",", " ")']) {
    row.channel_display_name = row['REPLACE(channel_display_name, ",", " ")'];
    delete row['REPLACE(channel_display_name, ",", " ")'];
  }
  if (row['REPLACE(video_title, ",", " ")']) {
    row.video_title = row['REPLACE(video_title, ",", " ")'];
    delete row['REPLACE(video_title, ",", " ")'];
  }
  return row;
}

// Validate each uploaded file
async function validateInputCSVs(context) {
  const errors = [];

  for (const [fileType, filePath] of Object.entries(context.files)) {
    if (!filePath || !VALID_COLUMNS[fileType] || fileType === 'claimsSource') continue;

    try {
      // Read only first 2 few lines to get headers
      const fileContent = await fs.readFile(filePath, 'utf8');
      const lines = fileContent.split('\n').slice(0, 2);
      const csvContent = lines.join('\n');

      // Parse headers
      let rows = csv.parse(csvContent, { columns: true });
      if (rows.length === 0) {
        errors.push(`${fileType}: File appears to be empty`);
        continue;
      }

      // Apply column normalization for claims files
      if (fileType === 'claims' && rows[0]) {
        rows[0] = normalizeClaimsColumns(rows[0]);
      }

      const actualColumns = Object.keys(rows[0]);
      const validColumns = VALID_COLUMNS[fileType];

      // Check for invalid columns (columns that don't exist in MySQL table)
      const invalidColumns = actualColumns.filter(col => !validColumns.includes(col));

      if (invalidColumns.length > 0) {
        errors.push(`${fileType}: Invalid columns (don't exist in table): ${invalidColumns.join(', ')}`);
      }

      console.log(`${fileType}: ${actualColumns.length} columns found, all valid`);

    } catch (error) {
      errors.push(`${fileType}: Failed to parse CSV - ${error.message}`);
    }
  }

  // Fail if any validation errors
  if (errors.length > 0) {
    throw new Error(`CSV validation failed:\n${errors.join('\n')}`);
  }

  console.log('✓ All CSV files validated successfully');
  return { validated: true };
}

module.exports = validateInputCSVs;