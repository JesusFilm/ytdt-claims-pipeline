const path = require('path');
const { format } = require('date-fns');
const { getOrCreateFolder, uploadFileWithFallback } = require('../lib/driveUpload');


async function uploadDrive(context) {

  if (!context.outputs.exports || Object.keys(context.outputs.exports).length === 0) {
    console.log('No files to upload');
    return;
  }

  try {

    // Lookup today's folder in shared drive and get its ID
    const folderName = format(context.startTime, 'yyyyMMddHHmmss');
    const folderId = await getOrCreateFolder(folderName, process.env.GOOGLE_DRIVE_NAME);

    // Upload each file
    const uploadedFiles = [];
    console.log(`Uploading ${Object.keys(context.outputs.exports).length} files to ${process.env.GOOGLE_DRIVE_NAME}/${folderName}`);
    for (const [viewName, exportInfo] of Object.entries(context.outputs.exports)) {
      const result = await uploadFileWithFallback(exportInfo.path, folderId, exportInfo.rows);
      uploadedFiles.push(result);
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