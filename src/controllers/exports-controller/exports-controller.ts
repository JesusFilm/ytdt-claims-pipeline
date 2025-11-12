import fs from 'fs/promises'
import path from 'path'

import { type Request, type Response } from 'express'
import { ObjectId } from 'mongodb'

import { getDatabase } from '../../database'
import { generateRunFolderName } from '../../lib/utils'

// Download uploaded files
export async function downloadUpload(req: Request, res: Response): Promise<void> {
  try {
    const filename = req.params.filename

    // Security: prevent path traversal
    if (!filename || filename.includes('..') || filename.includes('/')) {
      res.status(400).json({ error: 'Invalid filename' })
      return
    }

    const filePath = path.join(process.cwd(), 'data', 'uploads', filename)

    res.download(filePath, (err) => {
      if (err) {
        console.error('Upload download error:', err)
        if (!res.headersSent) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            res.status(404).json({ error: 'File not found' })
          } else {
            res.status(500).json({ error: 'Download failed' })
          }
        }
      }
    })
  } catch (error) {
    console.error('Upload download error:', error)
    if (!res.headersSent) {
      res.status(500).json({ error: 'Server error' })
    }
  }
}

// Download exported files
export async function downloadExport(req: Request, res: Response): Promise<void> {
  try {
    const runId = req.params.runId
    const filename = req.params.filename

    // Security: only allow .csv files and prevent path traversal
    if (!filename || !filename.endsWith('.csv') || filename.includes('..')) {
      res.status(400).json({ error: 'Invalid filename' })
      return
    }

    // Get run from database
    const db = getDatabase()
    const run = await db.collection('pipeline_runs').findOne({ _id: new ObjectId(runId) })
    if (!run) {
      res.status(404).json({ error: 'Run not found' })
      return
    }

    // Build folder name and file path
    const folderName = generateRunFolderName(run.startTime)
    const filePath = path.join(process.cwd(), 'data', 'exports', folderName, filename)

    res.download(filePath, (err) => {
      if (err) {
        console.error('Download error:', err)
        if (!res.headersSent) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            res.status(404).json({ error: 'File not found' })
          } else {
            res.status(500).json({ error: 'Download failed' })
          }
        }
      }
    })
  } catch (error) {
    console.error('Export download error:', error)
    if (!res.headersSent) {
      res.status(500).json({ error: 'Server error' })
    }
  }
}

// List available export files
export async function listExports(req: Request, res: Response): Promise<void> {
  try {
    const runId = req.params.runId

    // Get run from database
    const db = getDatabase()
    const run = await db.collection('pipeline_runs').findOne({ _id: new ObjectId(runId) })
    if (!run) {
      res.status(404).json({ error: 'Run not found' })
      return
    }

    // Build folder name from run startTime
    const folderName = generateRunFolderName(run.startTime)
    const exportsDir = path.join(process.cwd(), 'data', 'exports', folderName)

    const files = await fs.readdir(exportsDir)
    const csvFiles = files
      .filter((file) => file.endsWith('.csv'))
      .map(async (file) => {
        const filePath = path.join(exportsDir, file)
        const stats = await fs.stat(filePath)
        return {
          name: file,
          size: stats.size,
          created: stats.birthtime,
          modified: stats.mtime,
        }
      })

    const fileList = await Promise.all(csvFiles)

    res.json({
      files: fileList.sort((a, b) => b.modified.getTime() - a.modified.getTime()),
    })
  } catch (error) {
    console.error('List exports error:', error)
    res.status(500).json({ error: 'Failed to list exports' })
  }
}
