import { env } from '../../env'
import { getOrCreateFolder, uploadFileWithFallback } from '../../lib/drive-upload'
import { generateRunFolderName } from '../../lib/utils'

import type { PipelineContext } from '../../types/pipeline'

export default async function uploadDrive(context: PipelineContext) {
  const exports = context.outputs.exports as
    | Record<string, { path: string; rows: number }>
    | undefined
  if (!exports || Object.keys(exports).length === 0) {
    console.log('No files to upload')
    return
  }

  try {
    // Lookup today's folder in shared drive and get its ID
    const folderName = generateRunFolderName(
      context.startTime instanceof Date ? context.startTime : new Date(context.startTime)
    )
    if (!env.GOOGLE_DRIVE_NAME) {
      throw new Error('GOOGLE_DRIVE_NAME not configured')
    }
    const folderId = await getOrCreateFolder(folderName, env.GOOGLE_DRIVE_NAME)
    const folderUrl = `https://drive.google.com/drive/folders/${folderId}`

    // Upload each file
    const uploadedFiles = []
    console.log(
      `Uploading ${Object.keys(exports).length} files to ${env.GOOGLE_DRIVE_NAME}/${folderName}`
    )
    for (const [, exportInfo] of Object.entries(exports)) {
      const result = await uploadFileWithFallback(exportInfo.path, folderId, exportInfo.rows)
      uploadedFiles.push(result)
    }

    context.outputs.driveUploads = uploadedFiles
    context.outputs.driveFolderUrl = folderUrl
    console.log(`Uploaded ${uploadedFiles.length} files to: ${folderUrl}`)
  } catch (error) {
    console.error('Drive upload failed:', (error as Error).message)
    console.debug(error)
    // Don't fail pipeline for upload errors
  }
}
