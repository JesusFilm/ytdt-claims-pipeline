import { mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/utils/index.js', () => ({
  readFile: vi.fn(),
}))

vi.mock('csv-parse/sync', () => ({
  parse: vi.fn(),
}))

describe('validate-input-csvs', () => {
  let testDir
  let testFile

  beforeEach(() => {
    testDir = join(tmpdir(), 'test-validate')
    mkdirSync(testDir, { recursive: true })
    testFile = join(testDir, 'test.csv')
  })

  it('should validate valid CSV files', async () => {
    const { readFile } = await import('../../lib/utils/index.js')
    const { parse } = await import('csv-parse/sync')
    const validCsv = `claim_id,claim_status,video_id,channel_id
123,active,vid1,ch1
456,pending,vid2,ch2`
    readFile.mockResolvedValue(validCsv)
    parse.mockReturnValue([
      { claim_id: '123', claim_status: 'active', video_id: 'vid1', channel_id: 'ch1' },
      { claim_id: '456', claim_status: 'pending', video_id: 'vid2', channel_id: 'ch2' },
    ])

    const validateInputCSVs = (await import('../validate-input-csvs/index.js')).default
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
    const { readFile } = await import('../../lib/utils/index.js')
    const { parse } = await import('csv-parse/sync')
    const invalidCsv = `invalid_column1,invalid_column2
val1,val2`
    readFile.mockResolvedValue(invalidCsv)
    parse.mockReturnValue([{ invalid_column1: 'val1', invalid_column2: 'val2' }])

    const validateInputCSVs = (await import('../validate-input-csvs/index.js')).default
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
    const { readFile } = await import('../../lib/utils/index.js')
    const { parse } = await import('csv-parse/sync')
    readFile.mockResolvedValue('')
    parse.mockReturnValue([])

    const validateInputCSVs = (await import('../validate-input-csvs/index.js')).default
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
    const validateInputCSVs = (await import('../validate-input-csvs/index.js')).default
    const context = {
      files: {
        claims: {},
      },
    }

    const result = await validateInputCSVs(context)
    expect(result.status).toBe('completed')
  })

  it('should normalize column names', async () => {
    const { readFile } = await import('../../lib/utils/index.js')
    const { parse } = await import('csv-parse/sync')
    const csvWithNormalized = `claim_id,REPLACE(channel_display_name, ",", " "),REPLACE(video_title, ",", " ")
123,Channel Name,Video Title`
    readFile.mockResolvedValue(csvWithNormalized)
    // Mock parse to return rows with the normalized column names
    parse.mockReturnValue([
      {
        claim_id: '123',
        'REPLACE(channel_display_name, ",", " ")': 'Channel Name',
        'REPLACE(video_title, ",", " ")': 'Video Title',
      },
    ])

    const validateInputCSVs = (await import('../validate-input-csvs/index.js')).default
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
