#!/usr/bin/env node
/**
 * Run the daily claims ingest by hand (the same job the server schedules).
 *
 * Usage (on the VM, for the real run: MySQL is reached via VPN):
 *   node scripts/ingest-claims-report.js --dry-run   # list new reports: no download, VPN or DB writes
 *   node scripts/ingest-claims-report.js             # ingest + refresh YT-Validator's ASR queue
 */

require('dotenv').config();
const { connectToDatabase, closeConnection } = require('../src/database');
const { runClaimsIngest } = require('../src/jobs/claimsIngest');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  await connectToDatabase();
  try {
    const result = await runClaimsIngest({ trigger: 'manual', dryRun });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'failed') process.exitCode = 1;
  } finally {
    await closeConnection();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
