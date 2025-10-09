const path = require('path');
const { generateRunFolderName } = require('../lib/utils');
const { getOrCreateFolder, uploadFileWithFallback } = require('../lib/driveUpload');


async function uploadDrive(context) {

  if (!context.outputs.exports || Object.keys(context.outputs.exports).length === 0) {
    console.log('No files to upload');
    return;
  }

  try {

    // Lookup today's folder in shared drive and get its ID
    const folderName = generateRunFolderName(context.startTime);
    const folderId = await getOrCreateFolder(folderName, process.env.GOOGLE_DRIVE_NAME);
    const folderUrl = `https://drive.google.com/drive/folders/${folderId}`;

    // Upload each file
    const uploadedFiles = [];
    console.log(`Uploading ${Object.keys(context.outputs.exports).length} files to ${process.env.GOOGLE_DRIVE_NAME}/${folderName}`);
    for (const [viewName, exportInfo] of Object.entries(context.outputs.exports)) {
      const result = await uploadFileWithFallback(exportInfo.path, folderId, exportInfo.rows);
      uploadedFiles.push(result);
    }

    context.outputs.driveUploads = uploadedFiles;
    context.outputs.driveFolderUrl = folderUrl;
    console.log(`Uploaded ${uploadedFiles.length} files to: ${folderUrl}`);

  } catch (error) {
    console.error('Drive upload failed:', error.message);
    console.debug(error);
    // Don't fail pipeline for upload errors
  }
}

module.exports = uploadDrive;