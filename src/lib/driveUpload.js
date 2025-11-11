const { google } = require('googleapis');
const { createReadStream } = require('fs');
const path = require('path');
const fs = require('fs').promises;

let drive = null;

async function initDrive() {
  if (drive) return drive;

  const auth = new google.auth.GoogleAuth({
    keyFile: './config/service-account-key.json',
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  drive = google.drive({ version: 'v3', auth });
  return drive;
}

async function getOrCreateFolder(folderName, sharedDriveName) {
  const driveApi = await initDrive();

  const sharedDrives = await driveApi.drives.list();
  const sharedDrive = sharedDrives.data.drives.find((d) => d.name === sharedDriveName);
  if (!sharedDrive?.id) {
    throw new Error(`Shared drive not found: ${sharedDriveName}`);
  }

  const res = await driveApi.files.list({
    q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder'`,
    fields: 'files(id)',
    driveId: sharedDrive.id,
    corpora: 'drive',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
  });

  let folderId = res.data.files[0]?.id;
  if (!folderId) {
    const folder = await driveApi.files.create({
      requestBody: {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [sharedDrive.id],
      },
      fields: 'id',
      supportsAllDrives: true,
    });
    folderId = folder.data.id;
  }

  return folderId;
}

async function uploadFile(filePath, folderId, rows = null) {
  const driveApi = await initDrive();

  const file = await driveApi.files.create({
    requestBody: { name: path.basename(filePath), parents: [folderId] },
    media: { mimeType: 'text/csv', body: createReadStream(filePath) },
    fields: 'id, name, size',
    supportsAllDrives: true,
  });

  return {
    name: file.data.name,
    path: `https://drive.google.com/file/d/${file.data.id}/view`,
    size: parseInt(file.data.size),
    rows,
  };
}

async function uploadFileWithFallback(filePath, folderId, rows = null) {
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
      rows,
    };
  }
}

module.exports = { getOrCreateFolder, uploadFile, uploadFileWithFallback };
