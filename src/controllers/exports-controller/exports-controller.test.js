import fs from 'fs/promises'

import { ObjectId } from 'mongodb'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../database/index.js', () => ({
  getDatabase: vi.fn(),
}))

vi.mock('../../lib/utils/index.js', () => ({
  generateRunFolderName: vi.fn().mockReturnValue('20240115103000'),
}))

vi.mock('fs/promises', () => ({
  default: {
    readdir: vi.fn(),
    stat: vi.fn(),
  },
}))

describe('exports-controller', () => {
  let mockDb
  let mockCollection

  beforeEach(async () => {
    vi.clearAllMocks()
    mockCollection = {
      findOne: vi.fn(),
    }
    mockDb = {
      collection: vi.fn().mockReturnValue(mockCollection),
    }
    const { getDatabase } = await import('../../database/index.js')
    getDatabase.mockReturnValue(mockDb)
  })

  describe('downloadUpload', () => {
    it('should download upload file', async () => {
      const { downloadUpload } = await import('../exports-controller/index.js')
      const req = {
        params: { filename: 'test.csv' },
      }
      const res = {
        download: vi.fn().mockImplementation((path, callback) => {
          if (callback) callback(null)
        }),
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
        headersSent: false,
      }

      await downloadUpload(req, res)

      expect(res.download).toHaveBeenCalled()
    })

    it('should reject path traversal attempts', async () => {
      const { downloadUpload } = await import('../exports-controller/index.js')
      const req = {
        params: { filename: '../../../etc/passwd' },
      }
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      }

      await downloadUpload(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid filename' })
    })
  })

  describe('downloadExport', () => {
    it('should download export file', async () => {
      const { downloadExport } = await import('../exports-controller/index.js')
      const runId = new ObjectId()
      mockCollection.findOne.mockResolvedValue({
        _id: runId,
        startTime: new Date(),
      })

      const req = {
        params: { runId: runId.toString(), filename: 'test.csv' },
      }
      const res = {
        download: vi.fn().mockImplementation((path, callback) => {
          if (callback) callback(null)
        }),
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
        headersSent: false,
      }

      await downloadExport(req, res)

      expect(res.download).toHaveBeenCalled()
    })

    it('should reject non-CSV files', async () => {
      const { downloadExport } = await import('../exports-controller/index.js')
      const req = {
        params: { runId: 'test-id', filename: 'test.txt' },
      }
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      }

      await downloadExport(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
    })

    it('should return 404 if run not found', async () => {
      const { downloadExport } = await import('../exports-controller/index.js')
      mockCollection.findOne.mockResolvedValue(null)

      const req = {
        params: { runId: new ObjectId().toString(), filename: 'test.csv' },
      }
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      }

      await downloadExport(req, res)

      expect(res.status).toHaveBeenCalledWith(404)
    })
  })

  describe('listExports', () => {
    it('should list export files', async () => {
      const { listExports } = await import('../exports-controller/index.js')
      const runId = new ObjectId()
      mockCollection.findOne.mockResolvedValue({
        _id: runId,
        startTime: new Date(),
      })
      fs.readdir.mockResolvedValue(['file1.csv', 'file2.csv'])
      fs.stat.mockResolvedValue({
        size: 1000,
        birthtime: new Date(),
        mtime: new Date(),
      })

      const req = {
        params: { runId: runId.toString() },
      }
      const res = {
        json: vi.fn().mockReturnThis(),
      }

      await listExports(req, res)

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          files: expect.any(Array),
        })
      )
    })

    it('should return 404 if run not found', async () => {
      const { listExports } = await import('../exports-controller/index.js')
      mockCollection.findOne.mockResolvedValue(null)

      const req = {
        params: { runId: new ObjectId().toString() },
      }
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      }

      await listExports(req, res)

      expect(res.status).toHaveBeenCalledWith(404)
    })
  })
})
