import { env } from '../env.js'
import { getOrCreateFolder, uploadFileWithFallback } from '../lib/drive-upload.js'
import { generateRunFolderName } from '../lib/utils.js'

export default async function uploadDrive(context) {
  if (!context.outputs.exports || Object.keys(context.outputs.exports).length === 0) {
    console.log('No files to upload')
    return
  }

  try {
    // Lookup today's folder in shared drive and get its ID
    const folderName = generateRunFolderName(context.startTime)
    const folderId = await getOrCreateFolder(folderName, env.GOOGLE_DRIVE_NAME)
    const folderUrl = `https://drive.google.com/drive/folders/${folderId}`

    // Upload each file
    const uploadedFiles = []
    console.log(
      `Uploading ${Object.keys(context.outputs.exports).length} files to ${
        env.GOOGLE_DRIVE_NAME
      }/${folderName}`
    )
    for (const [, exportInfo] of Object.entries(context.outputs.exports)) {
      const result = await uploadFileWithFallback(exportInfo.path, folderId, exportInfo.rows)
      uploadedFiles.push(result)
    }

    context.outputs.driveUploads = uploadedFiles
    context.outputs.driveFolderUrl = folderUrl
    console.log(`Uploaded ${uploadedFiles.length} files to: ${folderUrl}`)
  } catch (error) {
    console.error('Drive upload failed:', error.message)
    console.debug(error)
    // Don't fail pipeline for upload errors
  }
}
