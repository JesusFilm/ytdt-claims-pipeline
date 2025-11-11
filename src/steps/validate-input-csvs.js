import { parse } from 'csv-parse/sync'

import { readFile } from '../lib/utils.js'

// Columns that currently exist in MySQL tables
const VALID_COLUMNS = {
  claims: [
    'claim_id',
    'claim_status',
    'claim_status_detail',
    'claim_origin',
    'claim_type',
    'asset_id',
    'video_id',
    'uploader',
    'channel_id',
    'channel_display_name',
    'video_title',
    'views',
    'matching_duration',
    'longest_match',
    'content_type',
    'reference_video_id',
    'reference_id',
    'claim_policy_id',
    'asset_policy_id',
    'claim_policy_monetize',
    'claim_policy_track',
    'claim_policy_block',
    'asset_policy_monetize',
    'asset_policy_track',
    'asset_policy_block',
    'claim_created_date',
    'video_upload_date',
    'custom_id',
    'video_duration_sec',
    'asset_title',
    'asset_labels',
    'tms',
    'director',
    'season',
    'episode_number',
    'episode_title',
    'release_date',
    'hfa_song_code',
    'isrc',
    'grid',
    'artist',
    'album',
    'record_label',
    'upc',
    'iswc',
    'writers',
    'engaged_views',
    'video_matching_length',
    'is_shorts_eligible',
  ],
  mcnVerdicts: ['video_id', 'verdict', 'media_component_id', 'language_id', 'wave', 'no_code'],
  jfmVerdicts: ['video_id', 'verdict', 'media_component_id', 'language_id', 'wave', 'no_code'],
}

// Handle column normalization from process-claims.js
function normalizeClaimsColumns(row) {
  if (row['REPLACE(channel_display_name, ",", " ")']) {
    row.channel_display_name = row['REPLACE(channel_display_name, ",", " ")']
    delete row['REPLACE(channel_display_name, ",", " ")']
  }
  if (row['REPLACE(video_title, ",", " ")']) {
    row.video_title = row['REPLACE(video_title, ",", " ")']
    delete row['REPLACE(video_title, ",", " ")']
  }
  return row
}

// Validate each uploaded file
export default async function validateInputCSVs(context) {
  const errors = []

  // Validate claims files (may have multiple sources)
  if (context.files.claims) {
    for (const [source, filePath] of Object.entries(context.files.claims)) {
      if (!filePath) continue

      let csvContent = ''
      try {
        csvContent = await readFile(filePath)
        let rows = parse(csvContent, {
          columns: true,
          max_record_size: 50000000, // 50MB per record
          relax_column_count: true,
        })

        if (rows.length === 0) {
          errors.push(`claims (${source}): File appears to be empty`)
          continue
        }

        rows[0] = normalizeClaimsColumns(rows[0])
        const actualColumns = Object.keys(rows[0])
        const validColumns = VALID_COLUMNS.claims
        const invalidColumns = actualColumns.filter((col) => !validColumns.includes(col))

        if (invalidColumns.length > 0) {
          errors.push(`claims (${source}): Invalid columns: ${invalidColumns.join(', ')}`)
        }

        console.log(`claims (${source}): ${actualColumns.length} columns found, all valid`)
      } catch (error) {
        errors.push(`claims (${source}): Failed to parse CSV - ${error.message}`)
        console.error(`First 500 chars of content:`, csvContent.substring(0, 500))
        console.error(`Error details:`, error)
      }
    }
  }

  // Validate verdict files (shared across sources)
  for (const fileType of ['mcnVerdicts', 'jfmVerdicts']) {
    const filePath = context.files[fileType]
    if (!filePath) continue

    let csvContent = ''
    try {
      csvContent = await readFile(filePath)

      let rows = parse(csvContent, {
        columns: true,
        max_record_size: 50000000, // 50MB per record
        relax_column_count: true,
      })
      if (rows.length === 0) {
        errors.push(`${fileType}: File appears to be empty`)
        continue
      }

      const actualColumns = Object.keys(rows[0])
      const validColumns = VALID_COLUMNS[fileType]
      const invalidColumns = actualColumns.filter((col) => !validColumns.includes(col))

      if (invalidColumns.length > 0) {
        errors.push(`${fileType}: Invalid columns: ${invalidColumns.join(', ')}`)
      }

      console.log(`${fileType}: ${actualColumns.length} columns found, all valid`)
    } catch (error) {
      errors.push(`${fileType}: Failed to parse CSV - ${error.message}`)
      console.error(`First 500 chars of content:`, csvContent.substring(0, 500))
    }
  }

  // Fail if any validation errors
  if (errors.length > 0) {
    throw new Error(`CSV validation failed:\n${errors.join('\n')}`)
  }

  console.log('✓ All CSV files validated successfully')
  return { status: 'completed' }
}
