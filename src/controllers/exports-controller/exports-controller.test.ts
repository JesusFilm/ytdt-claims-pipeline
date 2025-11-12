import fs from 'fs/promises'

import { ObjectId } from 'mongodb'

import type { Request, Response } from 'express'

vi.mock('../../database', () => ({
  getDatabase: vi.fn(),
}))

vi.mock('../../lib/utils', () => ({
  generateRunFolderName: vi.fn().mockReturnValue('20240115103000'),
}))

vi.mock('fs/promises', () => ({
  default: {
    readdir: vi.fn(),
    stat: vi.fn(),
  },
}))

describe('exports-controller', () => {
  let mockDb: {
    collection: ReturnType<typeof vi.fn>
  }
  let mockCollection: {
    findOne: ReturnType<typeof vi.fn>
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    mockCollection = {
      findOne: vi.fn(),
    }
    mockDb = {
      collection: vi.fn().mockReturnValue(mockCollection),
    }
    const { getDatabase } = await import('../../database')
    ;(getDatabase as ReturnType<typeof vi.fn>).mockReturnValue(mockDb)
  })

  describe('downloadUpload', () => {
    it('should download upload file', async () => {
      const { downloadUpload } = await import('../exports-controller')
      const req = {
        params: { filename: 'test.csv' },
      } as Request
      const res = {
        download: vi.fn().mockImplementation((_path, callback) => {
          if (callback) callback(null)
        }),
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
        headersSent: false,
      } as unknown as Response

      await downloadUpload(req, res)

      expect(res.download).toHaveBeenCalled()
    })

    it('should reject path traversal attempts', async () => {
      const { downloadUpload } = await import('../exports-controller')
      const req = {
        params: { filename: '../../../etc/passwd' },
      } as Request
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as unknown as Response

      await downloadUpload(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid filename' })
    })
  })

  describe('downloadExport', () => {
    it('should download export file', async () => {
      const { downloadExport } = await import('../exports-controller')
      const runId = new ObjectId()
      ;(mockCollection.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({
        _id: runId,
        startTime: new Date(),
      })

      const req = {
        params: { runId: runId.toString(), filename: 'test.csv' },
      } as Request
      const res = {
        download: vi.fn().mockImplementation((_path, callback) => {
          if (callback) callback(null)
        }),
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
        headersSent: false,
      } as unknown as Response

      await downloadExport(req, res)

      expect(res.download).toHaveBeenCalled()
    })

    it('should reject non-CSV files', async () => {
      const { downloadExport } = await import('../exports-controller')
      const req = {
        params: { runId: 'test-id', filename: 'test.txt' },
      } as Request
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as unknown as Response

      await downloadExport(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
    })

    it('should return 404 if run not found', async () => {
      const { downloadExport } = await import('../exports-controller')
      ;(mockCollection.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null)

      const req = {
        params: { runId: new ObjectId().toString(), filename: 'test.csv' },
      } as Request
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as unknown as Response

      await downloadExport(req, res)

      expect(res.status).toHaveBeenCalledWith(404)
    })
  })

  describe('listExports', () => {
    it('should list export files', async () => {
      const { listExports } = await import('../exports-controller')
      const runId = new ObjectId()
      ;(mockCollection.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({
        _id: runId,
        startTime: new Date(),
      })
      ;(fs.readdir as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
        'file1.csv',
        'file2.csv',
      ])
      ;(fs.stat as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        size: 1000,
        birthtime: new Date(),
        mtime: new Date(),
      })

      const req = {
        params: { runId: runId.toString() },
      } as Request
      const res = {
        json: vi.fn().mockReturnThis(),
      } as unknown as Response

      await listExports(req, res)

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          files: expect.any(Array),
        })
      )
    })

    it('should return 404 if run not found', async () => {
      const { listExports } = await import('../exports-controller')
      ;(mockCollection.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null)

      const req = {
        params: { runId: new ObjectId().toString() },
      } as Request
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as unknown as Response

      await listExports(req, res)

      expect(res.status).toHaveBeenCalledWith(404)
    })
  })
})
