import { createReadStream } from 'fs'

vi.mock('fs', () => ({
  createReadStream: vi.fn(),
}))

vi.mock('csv-parse', () => ({
  parse: vi.fn(),
}))

vi.mock('../../lib/utils', () => ({
  cleanRow: vi.fn((row) => row),
}))

describe('process-claims', () => {
  let mockMysql: {
    query: ReturnType<typeof vi.fn>
    escape: ReturnType<typeof vi.fn>
  }
  let mockStream: {
    pipe: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
  }
  let mockParser: {
    on: ReturnType<typeof vi.fn>
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    const { parse } = await import('csv-parse')

    mockParser = {
      on: vi.fn().mockReturnThis(),
    }

    // Make on() call the callback immediately for 'data' and 'end' events
    ;(mockParser.on as ReturnType<typeof vi.fn>).mockImplementation((event, callback) => {
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
    ;(parse as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockParser)
    mockStream = {
      pipe: vi.fn().mockReturnValue(mockParser),
      on: vi.fn(),
    }
    ;(createReadStream as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockStream)
    mockMysql = {
      query: vi.fn().mockResolvedValue([{ affectedRows: 10 }]),
      escape: vi.fn((val) => `'${val}'`),
    }
  })

  it('should process claims for matter_entertainment', async () => {
    const processClaims = (await import('../process-claims')).default
    const { parse } = await import('csv-parse')
    ;(parse as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockParser)

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
    const processClaims = (await import('../process-claims')).default
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
    const processClaims = (await import('../process-claims')).default
    const { parse } = await import('csv-parse')
    const otherParser = {
      on: vi.fn().mockReturnThis(),
    }
    ;(otherParser.on as ReturnType<typeof vi.fn>).mockImplementation((event, callback) => {
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
    ;(parse as unknown as ReturnType<typeof vi.fn>).mockReturnValue(otherParser)
    ;(mockStream.pipe as ReturnType<typeof vi.fn>).mockReturnValue(otherParser)

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
