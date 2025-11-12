import { createReadStream } from 'fs'
import fs from 'fs/promises'

import { google } from 'googleapis'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('googleapis', () => ({
  google: {
    drive: vi.fn(),
    auth: {
      GoogleAuth: vi.fn(),
    },
  },
}))

vi.mock('fs', () => ({
  createReadStream: vi.fn(),
}))

vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(),
  },
}))

describe('drive-upload', () => {
  let mockDriveApi
  let mockGoogleAuth

  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    mockDriveApi = {
      drives: {
        list: vi.fn().mockResolvedValue({
          data: {
            drives: [{ id: 'drive-id', name: 'test-drive' }],
          },
        }),
      },
      files: {
        list: vi.fn().mockResolvedValue({
          data: { files: [] },
        }),
        create: vi.fn().mockResolvedValue({
          data: { id: 'file-id', name: 'file.csv', size: '1000' },
        }),
      },
    }
    mockGoogleAuth = {
      getClient: vi.fn().mockResolvedValue({}),
    }
    google.drive.mockReturnValue(mockDriveApi)
    google.auth.GoogleAuth.mockImplementation(() => mockGoogleAuth)
    fs.readFile.mockClear()
  })

  describe('getOrCreateFolder', () => {
    it('should find existing folder', async () => {
      vi.resetModules()
      mockDriveApi.files.list.mockResolvedValue({
        data: { files: [{ id: 'existing-folder-id' }] },
      })
      const { getOrCreateFolder } = await import('../drive-upload/index.js')
      const folderId = await getOrCreateFolder('test-folder', 'test-drive')

      expect(folderId).toBe('existing-folder-id')
      expect(mockDriveApi.files.create).not.toHaveBeenCalled()
    })

    it('should create new folder if not found', async () => {
      vi.resetModules()
      mockDriveApi.files.list.mockResolvedValue({
        data: { files: [] },
      })
      mockDriveApi.files.create.mockResolvedValue({
        data: { id: 'new-folder-id' },
      })
      const { getOrCreateFolder } = await import('../drive-upload/index.js')
      const folderId = await getOrCreateFolder('test-folder', 'test-drive')

      expect(folderId).toBe('new-folder-id')
      expect(mockDriveApi.files.create).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: expect.objectContaining({
            name: 'test-folder',
            mimeType: 'application/vnd.google-apps.folder',
            parents: ['drive-id'],
          }),
          fields: 'id',
          supportsAllDrives: true,
        })
      )
    })

    it('should throw error if shared drive not found', async () => {
      const { getOrCreateFolder } = await import('../drive-upload/index.js')
      mockDriveApi.drives.list.mockResolvedValue({
        data: { drives: [] },
      })

      await expect(getOrCreateFolder('test-folder', 'nonexistent-drive')).rejects.toThrow(
        'Shared drive not found'
      )
    })
  })

  describe('uploadFile', () => {
    it('should upload file successfully', async () => {
      vi.resetModules()
      const mockStream = { pipe: vi.fn() }
      createReadStream.mockReturnValue(mockStream)
      mockDriveApi.files.create.mockResolvedValue({
        data: { id: 'file-id', name: 'file.csv', size: '1000' },
      })
      const { uploadFile } = await import('../drive-upload/index.js')
      const result = await uploadFile('/path/to/file.csv', 'folder-id', 100)

      expect(result).toEqual({
        name: 'file.csv',
        path: 'https://drive.google.com/file/d/file-id/view',
        size: 1000,
        rows: 100,
      })
      expect(mockDriveApi.files.create).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: { name: 'file.csv', parents: ['folder-id'] },
          media: expect.objectContaining({
            mimeType: 'text/csv',
            body: mockStream,
          }),
          fields: 'id, name, size',
          supportsAllDrives: true,
        })
      )
    })
  })

  describe('uploadFileWithFallback', () => {
    it('should return upload result on success', async () => {
      vi.resetModules()
      const mockStream = { pipe: vi.fn() }
      createReadStream.mockReturnValue(mockStream)
      mockDriveApi.files.create.mockResolvedValue({
        data: { id: 'file-id', name: 'file.csv', size: '1000' },
      })
      const { uploadFileWithFallback } = await import('../drive-upload/index.js')
      const result = await uploadFileWithFallback('/path/to/file.csv', 'folder-id', 100)

      expect(result.rows).toBe(100)
      expect(result.path).toContain('drive.google.com')
    })

    it('should return fallback result on upload failure', async () => {
      vi.resetModules()
      const mockStream = { pipe: vi.fn() }
      createReadStream.mockReturnValue(mockStream)
      mockDriveApi.files.create.mockRejectedValue(new Error('Upload failed'))
      fs.readFile.mockResolvedValue(Buffer.from('test content'))
      const { uploadFileWithFallback } = await import('../drive-upload/index.js')
      const result = await uploadFileWithFallback('/path/to/file.csv', 'folder-id', 100)

      expect(result.name).toBe('file.csv')
      expect(result.path).toBe('/path/to/file.csv')
      expect(result.size).toBe(12)
      expect(result.rows).toBe(100)
    })
  })
})
