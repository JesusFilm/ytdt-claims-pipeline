const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

/**
 * Telling uploaded CSVs apart without asking which box they belong in.
 *
 * Both mistakes this prevents happened: claims files dropped into the verdicts
 * slots because a file called "All_NO_Claims_MCN_..." sounds like claims, and
 * MCN verdicts mistaken for JFM, which no header can settle — the two have the
 * same seven columns. Only the content separates them.
 */

// A verdicts file is exactly these; see validate-input-csvs.js
const VERDICT_COLUMNS = ['video_id', 'verdict', 'media_component_id', 'language_id', 'wave', 'no_code', 'is_edited'];
// Columns no verdicts file carries, and every claims report does
const CLAIMS_MARKERS = ['claim_id', 'asset_id', 'video_title'];

// Ben's files have arrived as "no-code" and "verdict " more than once, and the
// run then failed on a header nobody could see was wrong.
function normalizeHeader(name) {
  return String(name).replace(/^﻿/, '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function headerColumns(headerLine) {
  return headerLine.split(',').map(normalizeHeader).filter(Boolean);
}

// 'verdicts' | 'claims' | 'unknown', from the header alone
function classifyCsv(headerLine) {
  const columns = new Set(headerColumns(headerLine));
  if (CLAIMS_MARKERS.every(c => columns.has(c))) return 'claims';
  // every verdict column present; trailing empty columns are ignored above
  if (VERDICT_COLUMNS.every(c => columns.has(c))) return 'verdicts';
  return 'unknown';
}

// video_ids of our own channels, from the newest owned_videos.csv an export
// produced. A local file rather than a MySQL query: this runs while someone
// waits in Slack, and the pipeline's database is only reachable over the VPN.
function ownedVideoIds(exportsDir = path.join(process.cwd(), 'data', 'exports')) {
  let newest = null;
  const walk = dir => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'owned_videos.csv') {
        const at = fs.statSync(full).mtimeMs;
        if (!newest || at > newest.at) newest = { full, at };
      }
    }
  };
  walk(exportsDir);
  if (!newest) return null;

  // Parsed, not split on commas: owned_videos.csv carries video descriptions,
  // which contain commas and quotes. Splitting shifted every later column and
  // silently produced ids that matched nothing.
  return new Set(readColumn(newest.full, 'video_id'));
}

// One column out of a CSV, headers normalised, quoting respected.
function readColumn(filePath, column) {
  const rows = parse(fs.readFileSync(filePath), {
    columns: header => header.map(normalizeHeader),
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
  });
  return rows.map(row => (row[column] || '').trim()).filter(Boolean);
}

/**
 * MCN verdicts are claims on other people's videos; JFM verdicts are our own.
 * So the share of ids we own decides it, and a rename cannot move that number.
 * Returns 'jfm' | 'mcn' | 'unsure' with the evidence, so an unsure answer can
 * be put to the person instead of guessed.
 */
function classifyVerdicts(videoIds, ownedIds, { ownedHigh = 0.7, ownedLow = 0.3, sample = 200 } = {}) {
  if (!ownedIds || !ownedIds.size || !videoIds.length) {
    return { kind: 'unsure', ratio: null, sampled: 0, reason: 'no owned-videos export to compare against' };
  }
  const step = Math.max(1, Math.floor(videoIds.length / sample));
  const taken = [];
  for (let i = 0; i < videoIds.length && taken.length < sample; i += step) taken.push(videoIds[i]);

  const owned = taken.filter(id => ownedIds.has(id)).length;
  const ratio = owned / taken.length;
  const kind = ratio >= ownedHigh ? 'jfm' : ratio <= ownedLow ? 'mcn' : 'unsure';
  return { kind, ratio, sampled: taken.length, reason: null };
}

// video_id column of a verdicts file, for classifyVerdicts
function readVideoIds(filePath, limit = 5000) {
  return readColumn(filePath, 'video_id').slice(0, limit);
}

module.exports = { classifyCsv, classifyVerdicts, ownedVideoIds, readVideoIds, normalizeHeader, VERDICT_COLUMNS };
