import { createReadStream } from 'fs'
import fs from 'fs/promises'
import path from 'path'

import { google, type drive_v3 } from 'googleapis'

let drive: drive_v3.Drive | null = null

async function initDrive() {
  if (drive) return drive

  const auth = new google.auth.GoogleAuth({
    keyFile: './config/service-account-key.json',
    scopes: ['https://www.googleapis.com/auth/drive'],
  })
  drive = google.drive({ version: 'v3', auth })
  return drive
}

export async function getOrCreateFolder(
  folderName: string,
  sharedDriveName: string
): Promise<string> {
  const driveApi = await initDrive()

  const sharedDrives = await driveApi.drives.list()
  const sharedDrive = sharedDrives.data.drives?.find((d) => d.name === sharedDriveName)
  if (!sharedDrive?.id) {
    throw new Error(`Shared drive not found: ${sharedDriveName}`)
  }

  const res = await driveApi.files.list({
    q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder'`,
    fields: 'files(id)',
    driveId: sharedDrive.id,
    corpora: 'drive',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
  })

  let folderId = res.data.files?.[0]?.id
  if (!folderId) {
    const folder = await driveApi.files.create({
      requestBody: {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [sharedDrive.id],
      },
      fields: 'id',
      supportsAllDrives: true,
    })
    folderId = folder.data.id || ''
  }

  return folderId
}

export async function uploadFile(filePath: string, folderId: string, rows: number | null = null) {
  const driveApi = await initDrive()

  const file = await driveApi.files.create({
    requestBody: { name: path.basename(filePath), parents: [folderId] },
    media: { mimeType: 'text/csv', body: createReadStream(filePath) },
    fields: 'id, name, size',
    supportsAllDrives: true,
  })

  return {
    name: file.data.name || '',
    path: `https://drive.google.com/file/d/${file.data.id}/view`,
    size: parseInt(file.data.size || '0', 10),
    rows,
  }
}

export async function uploadFileWithFallback(
  filePath: string,
  folderId: string,
  rows: number | null = null
) {
  try {
    const result = await uploadFile(filePath, folderId, rows)
    return { ...result, rows }
  } catch (uploadError) {
    console.error(`Upload failed for ${path.basename(filePath)}:`, (uploadError as Error).message)
    const fileContent = await fs.readFile(filePath)
    return {
      name: path.basename(filePath),
      path: filePath,
      size: fileContent.length,
      rows,
    }
  }
}
