vi.mock('../../lib/drive-upload', () => ({
  getOrCreateFolder: vi.fn(),
  uploadFileWithFallback: vi.fn(),
}))

vi.mock('../../lib/utils', () => ({
  generateRunFolderName: vi.fn().mockReturnValue('20240115103000'),
}))

vi.mock('../../env', () => ({
  env: {
    GOOGLE_DRIVE_NAME: 'test-drive',
  },
}))

describe('upload-drive', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should upload files to Drive', async () => {
    const { getOrCreateFolder, uploadFileWithFallback } = await import('../../lib/drive-upload')
    ;(getOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValue('folder-id')
    ;(uploadFileWithFallback as ReturnType<typeof vi.fn>).mockResolvedValue({
      name: 'test.csv',
      path: 'https://drive.google.com/file/d/file-id/view',
      size: 1000,
      rows: 100,
    })

    const uploadDrive = (await import('../upload-drive')).default
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
    const uploadDrive = (await import('../upload-drive')).default
    const context = {
      outputs: {},
      startTime: new Date(),
    }

    await uploadDrive(context)

    const { getOrCreateFolder } = await import('../../lib/drive-upload')
    expect(getOrCreateFolder).not.toHaveBeenCalled()
  })

  it('should handle upload errors gracefully', async () => {
    const { getOrCreateFolder } = await import('../../lib/drive-upload')
    ;(getOrCreateFolder as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Drive error'))

    const uploadDrive = (await import('../upload-drive')).default
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
