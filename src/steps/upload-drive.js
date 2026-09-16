const path = require('path');
const { generateRunFolderName } = require('../lib/utils');
const { getRunFolderId, uploadFileWithFallback } = require('../lib/driveUpload');
const { raiseAlert, clearAlert } = require('../lib/serviceAlerts');

const DRIVE_ALERT = 'drive-upload';


async function uploadDrive(context) {

  if (!context.outputs.exports || Object.keys(context.outputs.exports).length === 0) {
    console.log('No files to upload');
    return;
  }

  try {

    // Lookup today's folder in shared drive and get its ID
    const folderName = generateRunFolderName(context.startTime);
    const folderId = await getRunFolderId(context.runId, folderName, process.env.GOOGLE_DRIVE_NAME);
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
    await clearAlert(DRIVE_ALERT);

  } catch (error) {
    console.error('Drive upload failed:', error.message);
    console.debug(error);
    // The run still completes — exports exist locally and the pipeline's work
    // is done — but nobody gets the files, which is silent unless we say so.
    await raiseAlert(DRIVE_ALERT,
      `:file_folder: *Drive upload failed*\n${error.message}\n` +
      `Exports are on the VM under data/exports, but they are not reaching ` +
      `${process.env.GOOGLE_DRIVE_NAME || 'the shared drive'}. Runs will keep completing without them.`);
  }
}

module.exports = uploadDrive;