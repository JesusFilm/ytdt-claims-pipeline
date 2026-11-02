const { google } = require('googleapis');
const { createReadStream } = require('fs');
const path = require('path');
const fs = require('fs').promises;


let drive = null;

async function initDrive() {
  if (drive) return drive;
  
  const auth = new google.auth.GoogleAuth({
    keyFile: './config/service-account-key.json',
    scopes: ['https://www.googleapis.com/auth/drive']
  });
  drive = google.drive({ version: 'v3', auth });
  return drive;
}

async function getOrCreateFolder(folderName, sharedDriveName) {
  const driveApi = await initDrive();

  const sharedDrives = await driveApi.drives.list();
  const sharedDrive = sharedDrives.data.drives.find(d => d.name === sharedDriveName);
  if (!sharedDrive?.id) {
    throw new Error(`Shared drive not found: ${sharedDriveName}`);
  }

  // Drive allows several folders to share a name, so the lookup has to be
  // precise: same parent, not trashed, and ordered so that concurrent callers
  // which both miss the index still converge on the same (oldest) folder.
  const escaped = folderName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const query = `name='${escaped}' and mimeType='application/vnd.google-apps.folder' `
    + `and '${sharedDrive.id}' in parents and trashed=false`;

  const findFolders = async () => {
    const res = await driveApi.files.list({
      q: query,
      fields: 'files(id, createdTime)',
      orderBy: 'createdTime',
      driveId: sharedDrive.id,
      corpora: 'drive',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true
    });
    return res.data.files ?? [];
  };

  const existing = await findFolders();
  if (existing.length) return existing[0].id;

  const folder = await driveApi.files.create({
    requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [sharedDrive.id] },
    fields: 'id',
    supportsAllDrives: true
  });

  // Drive's search index is eventually consistent: another caller may have
  // created the same folder while our lookup was in flight. Re-read and keep
  // the oldest, so a duplicate created here is not the one we go on to use.
  const after = await findFolders();
  return after.length ? after[0].id : folder.data.id;
}


/**
 * Folder id for a pipeline run, memoised on the run document.
 *
 * The pipeline's upload-drive step and the ML webhook both upload into the same
 * run folder, and either can go first -- since the model got fast, the webhook
 * often wins. Recording the id on the run makes them agree without relying on
 * Drive's search index catching up.
 */
async function getRunFolderId(runId, folderName, sharedDriveName) {
  const { getDatabase } = require('../database');
  const { ObjectId } = require('mongodb');
  const runs = getDatabase().collection('pipeline_runs');
  const _id = new ObjectId(runId);

  const existing = await runs.findOne({ _id }, { projection: { 'results.driveFolderId': 1 } });
  if (existing?.results?.driveFolderId) return existing.results.driveFolderId;

  const folderId = await getOrCreateFolder(folderName, sharedDriveName);

  // Only the first writer wins; anyone else adopts the id already stored.
  await runs.updateOne(
    { _id, 'results.driveFolderId': { $exists: false } },
    { $set: { 'results.driveFolderId': folderId } }
  );
  const settled = await runs.findOne({ _id }, { projection: { 'results.driveFolderId': 1 } });
  return settled?.results?.driveFolderId ?? folderId;
}


// A connection that dropped, or a Drive that asked us to come back later.
// Anything else -- a bad folder id, no permission -- fails the same on a
// second try, so retrying it only delays the alert.
const RETRYABLE_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_STREAM_PREMATURE_CLOSE',
]);

function isRetryable(error) {
  const status = error?.response?.status ?? error?.code;
  if (status === 429 || (Number.isInteger(status) && status >= 500)) return true;
  // fetch wraps the real cause one level down: `read ETIMEDOUT` arrives as a
  // FetchError whose own code says nothing.
  return RETRYABLE_CODES.has(error?.code) || RETRYABLE_CODES.has(error?.cause?.code)
    || [...RETRYABLE_CODES].some(code => String(error?.message || '').includes(code));
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Uploads the file, and tries again when the network drops it.
 *
 * googleapis will not do this for us: gaxios retries only GET, HEAD, PUT,
 * OPTIONS and DELETE (its httpMethodsToRetry default), and an upload is a POST.
 * The reason is the body -- a retry would re-send a stream already consumed and
 * write an empty file -- so the attempt is made here, where a fresh
 * createReadStream can be opened for each one.
 *
 * Without this, one `read ETIMEDOUT` lost a scored claims CSV that the model
 * had already spent the time to produce.
 */
async function uploadFile(filePath, folderId, rows=null, { attempts = 4, baseDelayMs = 2000 } = {}) {
  const driveApi = await initDrive();
  const name = path.basename(filePath);

  for (let attempt = 1; ; attempt++) {
    try {
      const file = await driveApi.files.create({
        requestBody: { name, parents: [folderId] },
        media: { mimeType: 'text/csv', body: createReadStream(filePath) },
        fields: 'id, name, size',
        supportsAllDrives: true
      });

      if (attempt > 1) console.log(`Drive upload of ${name} succeeded on attempt ${attempt}`);
      return {
        name: file.data.name,
        path: `https://drive.google.com/file/d/${file.data.id}/view`,
        size: parseInt(file.data.size),
        rows
      };

    } catch (error) {
      if (attempt >= attempts || !isRetryable(error)) throw error;
      // 2s, 4s, 8s, plus jitter so two uploads that broke together do not come
      // back together.
      const delay = baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
      console.warn(`Drive upload of ${name} failed (attempt ${attempt}/${attempts}): ${error.message}. Retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
}

async function uploadFileWithFallback(filePath, folderId, rows=null) {
  try {
    const result = await uploadFile(filePath, folderId, rows);
    return { ...result, rows };

  } catch (uploadError) {
    console.error(`Upload failed for ${path.basename(filePath)}:`, uploadError.message);
    const fileContent = await fs.readFile(filePath);
    return {
      name: path.basename(filePath),
      path: filePath,
      size: fileContent.length,
      rows
    };
  }
}

module.exports = { getOrCreateFolder, getRunFolderId, uploadFile, uploadFileWithFallback };