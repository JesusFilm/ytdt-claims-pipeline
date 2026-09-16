const { format } = require('date-fns');
const { parse } = require('csv-parse/sync');
const fs = require('fs');
const path = require('path');


module.exports.cleanRow = function (row) {
  const cleaned = {};
  Object.entries(row).forEach(([key, value]) => {
    if (typeof value === 'string') {
      value = value.trim();
      value = value.replace(/\r/g, '');
      value = value.replace(/^'|'$/g, ''); // Remove Excel quotes
    }
    cleaned[key.trim()] = value;
  });
  return cleaned;
}


module.exports.formatDuration = (ms) => {
  if (!ms) return `♾️`;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
};


// Human-readable label for the run's Drive folder, e.g. "Sep 16 2026 01:53:36 AM".
module.exports.generateRunFolderName = (startTime) =>
  format(startTime, process.env.EXPORT_FOLDER_NAME_FORMAT || 'yyyyMMddHHmmss');


// Name of the run's directory on disk. Deliberately NOT the Drive label:
// EXPORT_FOLDER_NAME_FORMAT is free-form and in production yields spaces and
// colons ("Sep 16 2026 01:53:36 AM"). Colons make scp/rsync/gcloud read the
// path as host:path, spaces need quoting in every shell, and both are illegal
// on Windows. This name also sorts chronologically, which the label does not.
module.exports.runDirName = (startTime) => format(startTime, 'yyyyMMddHHmmss');


// Where a run's exports live. Prefers the safe name, but falls back to the
// legacy Drive-label directory for runs exported before the split, so their
// files stay downloadable. Returns the safe path when neither exists (creation).
module.exports.resolveRunExportDir = (startTime, baseDir) => {
  const base = baseDir || path.join(process.cwd(), 'data', 'exports');
  const safe = path.join(base, module.exports.runDirName(startTime));
  if (fs.existsSync(safe)) return safe;

  const legacy = path.join(base, module.exports.generateRunFolderName(startTime));
  return fs.existsSync(legacy) ? legacy : safe;
};


module.exports.readFile = async function (filePath, n = 2) {
  const readline = require('readline');
  const rl = readline.createInterface({
    input: require('fs').createReadStream(filePath),
    crlfDelay: Infinity
  });
  
  const lines = [];
  for await (const line of rl) {
    lines.push(line);
    if (lines.length === n) break;
  }
  rl.close();
  return lines.join('\n');
}


module.exports.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));


module.exports.mapWithConcurrency = async (items, concurrency, fn, delayMs = 500) => {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    results.push(...await Promise.all(batch.map(fn)));
    if (i + concurrency < items.length) await module.exports.sleep(delayMs);

  }
  return results;
}


module.exports.readCsv = (file) => fs.existsSync(file) ? 
  parse(fs.readFileSync(file), { columns: true, skip_empty_lines: true }) : null;


/**
 * Render a timestamp in the team's timezone, labelled.
 *
 * Node's toLocaleString() with no options follows the *server's* locale, so the
 * same run reads 7:12 AM in New York and 1:12 PM on a European host, with
 * nothing saying which. Everyone reading these notifications works to Eastern
 * time, so pin it there and print the zone (EDT/EST as appropriate).
 */
module.exports.formatTimestamp = (value, timeZone = process.env.DISPLAY_TIMEZONE || 'America/New_York') => {
  if (!value) return 'Unknown';
  const d = new Date(value);
  if (isNaN(d.getTime())) return 'Unknown';
  return d.toLocaleString('en-US', {
    timeZone,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit',
    timeZoneName: 'short'
  });
};
