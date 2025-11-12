import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/drive-upload/index.js', () => ({
  getOrCreateFolder: vi.fn(),
  uploadFileWithFallback: vi.fn(),
}))

vi.mock('../../lib/utils/index.js', () => ({
  generateRunFolderName: vi.fn().mockReturnValue('20240115103000'),
}))

vi.mock('../../env/index.js', () => ({
  env: {
    GOOGLE_DRIVE_NAME: 'test-drive',
  },
}))

describe('upload-drive', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should upload files to Drive', async () => {
    const { getOrCreateFolder, uploadFileWithFallback } = await import(
      '../../lib/drive-upload/index.js'
    )
    getOrCreateFolder.mockResolvedValue('folder-id')
    uploadFileWithFallback.mockResolvedValue({
      name: 'test.csv',
      path: 'https://drive.google.com/file/d/file-id/view',
      size: 1000,
      rows: 100,
    })

    const uploadDrive = (await import('../upload-drive/index.js')).default
    const context = {
      outputs: {
        exports: {
          export_all_claims: {
            path: '/path/to/all_claims.csv',
            rows: 100,
          },
        },
      },
      startTime: new Date(),
    }

    await uploadDrive(context)

    expect(getOrCreateFolder).toHaveBeenCalled()
    expect(uploadFileWithFallback).toHaveBeenCalled()
    expect(context.outputs.driveUploads).toBeDefined()
    expect(context.outputs.driveFolderUrl).toBeDefined()
  })

  it('should skip if no exports', async () => {
    const uploadDrive = (await import('../upload-drive/index.js')).default
    const context = {
      outputs: {},
      startTime: new Date(),
    }

    await uploadDrive(context)

    const { getOrCreateFolder } = await import('../../lib/drive-upload/index.js')
    expect(getOrCreateFolder).not.toHaveBeenCalled()
  })

  it('should handle upload errors gracefully', async () => {
    const { getOrCreateFolder } = await import('../../lib/drive-upload/index.js')
    getOrCreateFolder.mockRejectedValue(new Error('Drive error'))

    const uploadDrive = (await import('../upload-drive/index.js')).default
    const context = {
      outputs: {
        exports: {
          export_all_claims: {
            path: '/path/to/all_claims.csv',
            rows: 100,
          },
        },
      },
      startTime: new Date(),
    }

    await expect(uploadDrive(context)).resolves.not.toThrow()
  })
})
