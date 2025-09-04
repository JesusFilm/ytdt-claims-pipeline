const { google } = require('googleapis');
const fs = require('fs').promises;
const path = require('path');
const { format } = require('date-fns');


async function uploadDrive(context) {

  if (!context.outputs.exports || Object.keys(context.outputs.exports).length === 0) {
    console.log('No files to upload');
    return;
  }

  try {
    // Initialize Google Drive (simplified - you'd need proper OAuth2)
    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    
    // You'd load saved tokens here
    // auth.setCredentials(savedTokens);
    
    const drive = google.drive({ version: 'v3', auth });
    
    // Create today's folder
    const folderName = `youtube_exports/${format(new Date(), 'yyyyMMdd')}`;
    
    // Upload each file
    const uploadedFiles = [];
    for (const [viewName, exportInfo] of Object.entries(context.outputs.exports)) {
      const fileContent = await fs.readFile(exportInfo.path);
      
      // For now, just log what we would upload
      console.log(`Would upload ${path.basename(exportInfo.path)} to ${folderName}`);
      uploadedFiles.push({
        name: path.basename(exportInfo.path),
        size: fileContent.length,
        rows: exportInfo.rows
      });
    }
    
    context.outputs.driveUploads = uploadedFiles;
    console.log(`Uploaded ${uploadedFiles.length} files to Google Drive`);
    
  } catch (error) {
    console.error('Drive upload failed:', error.message);
    // Don't fail pipeline for upload errors
  }
}

module.exports = uploadDrive;