import { createReadStream } from 'fs'

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('fs', () => ({
  createReadStream: vi.fn(),
}))

vi.mock('csv-parse', () => ({
  parse: vi.fn(),
}))

vi.mock('../../lib/utils/index.js', () => ({
  cleanRow: vi.fn((row) => row),
}))

describe('process-claims', () => {
  let mockMysql
  let mockStream
  let mockParser

  beforeEach(async () => {
    vi.clearAllMocks()
    const { parse } = await import('csv-parse')

    mockParser = {
      on: vi.fn().mockReturnThis(),
    }

    // Make on() call the callback immediately for 'data' and 'end' events
    mockParser.on.mockImplementation((event, callback) => {
      if (event === 'data') {
        setTimeout(
          () => callback({ claim_id: '123', asset_labels: 'Jesus Film', channel_id: 'test' }),
          0
        )
      }
      if (event === 'end') {
        setTimeout(() => callback(), 10)
      }
      return mockParser
    })

    parse.mockReturnValue(mockParser)
    mockStream = {
      pipe: vi.fn().mockReturnValue(mockParser),
      on: vi.fn(),
    }
    createReadStream.mockReturnValue(mockStream)
    mockMysql = {
      query: vi.fn().mockResolvedValue([{ affectedRows: 10 }]),
      escape: vi.fn((val) => `'${val}'`),
    }
  })

  it('should process claims for matter_entertainment', async () => {
    const processClaims = (await import('../process-claims/index.js')).default
    const { parse } = await import('csv-parse')
    parse.mockReturnValue(mockParser)

    const context = {
      files: {
        claims: {
          matter_entertainment: '/path/to/file.csv',
        },
      },
      connections: {
        mysql: mockMysql,
      },
      outputs: {},
    }

    await processClaims(context, 'matter_entertainment')

    expect(mockMysql.query).toHaveBeenCalled()
    expect(context.outputs.claimsProcessed).toBeDefined()
  })

  it('should skip if file not provided', async () => {
    const processClaims = (await import('../process-claims/index.js')).default
    const context = {
      files: {
        claims: {},
      },
      connections: {
        mysql: mockMysql,
      },
    }

    await processClaims(context, 'matter_entertainment')

    expect(mockMysql.query).not.toHaveBeenCalled()
  })

  it('should filter claims correctly', async () => {
    const processClaims = (await import('../process-claims/index.js')).default
    const { parse } = await import('csv-parse')
    const otherParser = {
      on: vi.fn().mockReturnThis(),
    }
    otherParser.on.mockImplementation((event, callback) => {
      if (event === 'data') {
        setTimeout(
          () => callback({ claim_id: '123', asset_labels: 'Other', channel_id: 'other' }),
          0
        )
      }
      if (event === 'end') {
        setTimeout(() => callback(), 10)
      }
      return otherParser
    })
    parse.mockReturnValue(otherParser)
    mockStream.pipe.mockReturnValue(otherParser)

    const context = {
      files: {
        claims: {
          matter_entertainment: '/path/to/file.csv',
        },
      },
      connections: {
        mysql: mockMysql,
      },
      outputs: {},
    }

    await processClaims(context, 'matter_entertainment')

    expect(mockMysql.query).toHaveBeenCalled()
  })
})
