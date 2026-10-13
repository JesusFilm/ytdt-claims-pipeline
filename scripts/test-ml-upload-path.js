#!/usr/bin/env node

/*
Offline check for where the ML webhook writes the scored CSV before uploading
it to Drive. No network, no Drive, no Mongo.

  node scripts/test-ml-upload-path.js
*/

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.EXPORT_FOLDER_NAME_FORMAT = 'MMM d yyyy hh:mm:ss a';
const { generateRunFolderName, resolveRunExportDir, runDirName } = require('../src/lib/utils');

const startTime = new Date('2026-10-13T18:24:06Z');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'exports-'));
// the run's files as export-views writes them: the safe directory, not the label
fs.mkdirSync(path.join(base, runDirName(startTime)));

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`✓ ${name}`); }
  catch (error) { failed++; console.error(`✗ ${name}\n  ${error.message}`); }
};

check('the webhook writes where the run\'s files actually are', () => {
  const dir = resolveRunExportDir(startTime, base);
  assert.strictEqual(path.basename(dir), runDirName(startTime));
  assert.ok(fs.existsSync(dir), 'directory exists, so the write succeeds');
});

check('the Drive label is not a directory on disk', () => {
  // writing here is what raised ENOENT and left Ben without the scored CSV
  const label = generateRunFolderName(startTime);
  assert.notStrictEqual(label, runDirName(startTime));
  assert.ok(!fs.existsSync(path.join(base, label)), 'the label names a Drive folder, not a local one');
});

check('a legacy run exported under the label still resolves', () => {
  const legacy = new Date('2026-08-31T13:12:14Z');
  fs.mkdirSync(path.join(base, generateRunFolderName(legacy)));
  assert.strictEqual(path.basename(resolveRunExportDir(legacy, base)), generateRunFolderName(legacy));
});

fs.rmSync(base, { recursive: true, force: true });
console.log(`\n${3 - failed}/3 passed`);
process.exit(failed ? 1 : 0);
