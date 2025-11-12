import { mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../lib/utils', () => ({
  readFile: vi.fn(),
}))

vi.mock('csv-parse/sync', () => ({
  parse: vi.fn(),
}))

describe('validate-input-csvs', () => {
  let testDir: string
  let testFile: string

  beforeEach(() => {
    testDir = join(tmpdir(), 'test-validate')
    mkdirSync(testDir, { recursive: true })
    testFile = join(testDir, 'test.csv')
  })

  it('should validate valid CSV files', async () => {
    const { readFile } = await import('../../lib/utils')
    const { parse } = await import('csv-parse/sync')
    const validCsv = `claim_id,claim_status,video_id,channel_id
123,active,vid1,ch1
456,pending,vid2,ch2`
    ;(readFile as ReturnType<typeof vi.fn>).mockResolvedValue(validCsv)
    ;(parse as ReturnType<typeof vi.fn>).mockReturnValue([
      { claim_id: '123', claim_status: 'active', video_id: 'vid1', channel_id: 'ch1' },
      { claim_id: '456', claim_status: 'pending', video_id: 'vid2', channel_id: 'ch2' },
    ])

    const validateInputCSVs = (await import('../validate-input-csvs')).default
    const context = {
      files: {
        claims: {
          matter_entertainment: testFile,
        },
      },
    }

    const result = await validateInputCSVs(context)
    expect(result.status).toBe('completed')
  })

  it('should reject CSV with invalid columns', async () => {
    const { readFile } = await import('../../lib/utils')
    const { parse } = await import('csv-parse/sync')
    const invalidCsv = `invalid_column1,invalid_column2
val1,val2`
    ;(readFile as ReturnType<typeof vi.fn>).mockResolvedValue(invalidCsv)
    ;(parse as ReturnType<typeof vi.fn>).mockReturnValue([
      { invalid_column1: 'val1', invalid_column2: 'val2' },
    ])

    const validateInputCSVs = (await import('../validate-input-csvs')).default
    const context = {
      files: {
        claims: {
          matter_entertainment: testFile,
        },
      },
    }

    await expect(validateInputCSVs(context)).rejects.toThrow('CSV validation failed')
  })

  it('should reject empty CSV files', async () => {
    const { readFile } = await import('../../lib/utils')
    const { parse } = await import('csv-parse/sync')
    ;(readFile as ReturnType<typeof vi.fn>).mockResolvedValue('')
    ;(parse as ReturnType<typeof vi.fn>).mockReturnValue([])

    const validateInputCSVs = (await import('../validate-input-csvs')).default
    const context = {
      files: {
        claims: {
          matter_entertainment: testFile,
        },
      },
    }

    await expect(validateInputCSVs(context)).rejects.toThrow('CSV validation failed')
  })

  it('should skip missing files', async () => {
    const validateInputCSVs = (await import('../validate-input-csvs')).default
    const context = {
      files: {
        claims: {},
      },
    }

    const result = await validateInputCSVs(context)
    expect(result.status).toBe('completed')
  })

  it('should normalize column names', async () => {
    const { readFile } = await import('../../lib/utils')
    const { parse } = await import('csv-parse/sync')
    const csvWithNormalized = `claim_id,REPLACE(channel_display_name, ",", " "),REPLACE(video_title, ",", " ")
123,Channel Name,Video Title`
    ;(readFile as ReturnType<typeof vi.fn>).mockResolvedValue(csvWithNormalized)
    // Mock parse to return rows with the normalized column names
    ;(parse as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        claim_id: '123',
        'REPLACE(channel_display_name, ",", " ")': 'Channel Name',
        'REPLACE(video_title, ",", " ")': 'Video Title',
      },
    ])

    const validateInputCSVs = (await import('../validate-input-csvs')).default
    const context = {
      files: {
        claims: {
          matter_entertainment: testFile,
        },
      },
    }

    const result = await validateInputCSVs(context)
    expect(result.status).toBe('completed')
  })
})
