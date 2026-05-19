const { format } = require('date-fns');
const { parse } = require('csv-parse/sync');
const fs = require('fs');


module.exports.cleanRow = function (row) {
  const cleaned = {};
  Object.entries(row).forEach(([key, value]) => {
    if (typeof value === 'string') {
      value = value.trim();
      value = value.replace(/\r/g, '');
      value = value.replace(/^'|'$/g, ''); // Remove Excel quotes
    }
    cleaned[key] = value;
  });
  return cleaned;
}


module.exports.formatDuration = (ms) => {
  if (!ms) return `♾️`;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
};


module.exports.generateRunFolderName = (startTime) => 
  format(startTime, process.env.EXPORT_FOLDER_NAME_FORMAT || 'yyyyMMddHHmmss');


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
