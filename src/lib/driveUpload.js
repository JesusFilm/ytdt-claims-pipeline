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


async function uploadFile(filePath, folderId, rows=null) {
  const driveApi = await initDrive();
  
  const file = await driveApi.files.create({
    requestBody: { name: path.basename(filePath), parents: [folderId] },
    media: { mimeType: 'text/csv', body: createReadStream(filePath) },
    fields: 'id, name, size',
    supportsAllDrives: true
  });

  return {
    name: file.data.name,
    path: `https://drive.google.com/file/d/${file.data.id}/view`,
    size: parseInt(file.data.size),
    rows
  };
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