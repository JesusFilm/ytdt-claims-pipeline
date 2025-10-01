const { google } = require('googleapis');
const fs = require('fs').promises;
const { createReadStream } = require('fs');
const path = require('path');
const { format } = require('date-fns');


async function uploadDrive(context) {

  if (!context.outputs.exports || Object.keys(context.outputs.exports).length === 0) {
    console.log('No files to upload');
    return;
  }

  try {

    // Initialize Google Drive API
    const auth = new google.auth.GoogleAuth({
      keyFile: './config/service-account-key.json',
      scopes: ['https://www.googleapis.com/auth/drive']
    });
    const drive = google.drive({ version: 'v3', auth });

    // Get shared drive ID 
    const sharedDrives = await drive.drives.list();
    const sharedDrive = sharedDrives.data.drives.find(d => d.name === process.env.GOOGLE_DRIVE_NAME);
    if (!sharedDrive?.id) {
      throw new Error(`Shared drive not found: ${process.env.GOOGLE_DRIVE_NAME}`);
    }

    // Lookup today's folder in shared drive and get its ID
    const folderName = format(context.startTime, 'yyyyMMddHHmmss');
    const res = await drive.files.list({
      q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder'`,
      fields: 'files(id)',
      driveId: sharedDrive.id,
      corpora: 'drive',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true
    });

    // Create folder if doesn't exist
    let folderId = res.data.files[0]?.id;
    if (!folderId) {

      console.log(`Drive folder not found: ${folderName}. Creating it now...`);
      const folder = await drive.files.create({
        requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [sharedDrive.id] },
        fields: 'id',
        supportsAllDrives: true
      });

      folderId = folder.data.id;
      console.log(`Created folder: ${folderName} (${folderId})`);
    }

    // Upload each file
    const uploadedFiles = [];
    console.log(`Uploading ${Object.keys(context.outputs.exports).length} files to ${process.env.GOOGLE_DRIVE_NAME}/${folderName}`);
    for (const [viewName, exportInfo] of Object.entries(context.outputs.exports)) {
      try {

        // Upload to Drive
        const file = await drive.files.create({
          requestBody: { name: path.basename(exportInfo.path), parents: [folderId] },
          media: { mimeType: 'text/csv', body: createReadStream(exportInfo.path) },
          fields: 'id, name, size',
          supportsAllDrives: true
        });
        uploadedFiles.push({
          name: file.data.name,
          path: `https://drive.google.com/file/d/${file.data.id}/view`,
          size: parseInt(file.data.size),
          rows: exportInfo.rows
        });

      } catch (uploadError) {
        // Failover: just log what we would upload
        console.error(`Upload failed for ${path.basename(exportInfo.path)}:`, uploadError.message);
        const fileContent = await fs.readFile(exportInfo.path);
        uploadedFiles.push({
          name: path.basename(exportInfo.path),
          path: exportInfo.path,
          size: fileContent.length,
          rows: exportInfo.rows
        });
      }
    }

    context.outputs.driveUploads = uploadedFiles;
    console.log(`Uploaded ${uploadedFiles.length} files to: https://drive.google.com/drive/folders/${folderId}`);

  } catch (error) {
    console.error('Drive upload failed:', error.message);
    console.debug(error);
    // Don't fail pipeline for upload errors
  }
}

module.exports = uploadDrive;