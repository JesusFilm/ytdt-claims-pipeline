const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { google } = require('googleapis');


// Studio's "Claims report Version 1.2" is this report, byte for byte.
const REPORT_TYPE = 'content_owner_active_claims_a3';
const SCOPES = ['https://www.googleapis.com/auth/yt-analytics.readonly'];

// Claims source (as named by process-claims and the upload form) -> content owner id.
const CLAIMS_OWNERS = {
  matter_entertainment: process.env.YT_OWNER_MATTER_ENTERTAINMENT || 'J8g7R47ksUHF78DMrbZXYw',
  matter_2: process.env.YT_OWNER_MATTER_2 || 'MjvkwLDytS3jM7M22BkMWg',
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));


// User OAuth only: a service account cannot act for a content owner (403).
// YT_REPORTING_TOKEN_FILE is an authorized-user JSON holding refresh_token and,
// usually, client_id/client_secret; otherwise those come from the Desktop
// client JSON in YT_REPORTING_CLIENT_FILE.
function createAuth() {
  const tokenFile = process.env.YT_REPORTING_TOKEN_FILE;
  if (!tokenFile) {
    throw new Error('YT_REPORTING_TOKEN_FILE is not set');
  }
  const token = readJson(tokenFile);

  let { client_id: clientId, client_secret: clientSecret } = token;
  if ((!clientId || !clientSecret) && process.env.YT_REPORTING_CLIENT_FILE) {
    const client = readJson(process.env.YT_REPORTING_CLIENT_FILE);
    ({ client_id: clientId, client_secret: clientSecret } = client.installed || client.web || client);
  }
  if (!token.refresh_token || !clientId || !clientSecret) {
    throw new Error('YouTube Reporting credentials incomplete: need refresh_token, client_id and client_secret');
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: token.refresh_token });
  return auth;
}

async function listAll(call, key) {
  const items = [];
  let pageToken;
  do {
    const { data } = await call(pageToken);
    items.push(...(data[key] || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return items;
}

// Reports of the system-managed claims job, oldest first. YouTube produces them
// irregularly (~62h after the data date, with gaps of weeks) and keeps ~60 days.
async function listClaimsReports(auth, contentOwnerId) {
  const reporting = google.youtubereporting({ version: 'v1', auth });

  const jobs = await listAll(pageToken => reporting.jobs.list({
    onBehalfOfContentOwner: contentOwnerId, includeSystemManaged: true, pageToken
  }), 'jobs');
  const job = jobs.find(j => j.reportTypeId === REPORT_TYPE);
  if (!job) {
    throw new Error(`No ${REPORT_TYPE} job for content owner ${contentOwnerId}`);
  }

  const reports = await listAll(pageToken => reporting.jobs.reports.list({
    jobId: job.id, onBehalfOfContentOwner: contentOwnerId, pageToken
  }), 'reports');

  return reports
    .map(report => ({ ...report, jobId: job.id }))
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
}

// Streams a report to destPath as plain CSV. Reports arrive gzip-compressed
// (~180MB -> ~850MB); the magic bytes decide, not the response headers.
async function downloadReport(auth, report, destPath) {
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const raw = `${destPath}.download`;

  try {
    const res = await auth.request({ url: report.downloadUrl, responseType: 'stream' });
    await pipeline(res.data, fs.createWriteStream(raw));

    const handle = await fs.promises.open(raw, 'r');
    const { buffer } = await handle.read(Buffer.alloc(2), 0, 2, 0);
    await handle.close();

    if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
      await pipeline(fs.createReadStream(raw), zlib.createGunzip(), fs.createWriteStream(destPath));
    } else {
      await fs.promises.rename(raw, destPath);
    }
  } finally {
    await fs.promises.rm(raw, { force: true });
  }
  return destPath;
}

module.exports = {
  REPORT_TYPE,
  SCOPES,
  CLAIMS_OWNERS,
  createAuth,
  listClaimsReports,
  downloadReport
};
