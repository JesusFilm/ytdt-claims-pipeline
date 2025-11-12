import fs from 'fs/promises'

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(),
  },
}))

vi.mock('csv-parse/sync', () => ({
  parse: vi.fn(),
}))

vi.mock('../../lib/utils/index.js', () => ({
  cleanRow: vi.fn((row) => row),
}))

describe('process-verdicts', () => {
  let mockMysql

  beforeEach(() => {
    vi.clearAllMocks()
    mockMysql = {
      query: vi.fn().mockResolvedValue([[]]),
      escape: vi.fn((val) => (val === null ? 'NULL' : `'${val}'`)),
    }
  })

  it('should process MCN verdicts', async () => {
    const processVerdicts = (await import('../process-verdicts/index.js')).default
    const { parse } = await import('csv-parse/sync')
    parse.mockReturnValue([
      {
        video_id: 'vid1',
        verdict: 'Y',
        media_component_id: 'mcid1',
        language_id: 'lang1',
        wave: '1',
        no_code: 'code1',
      },
    ])
    fs.readFile.mockResolvedValue('csv content')

    const context = {
      files: {
        mcnVerdicts: '/path/to/mcn.csv',
      },
      connections: {
        mysql: mockMysql,
      },
      outputs: {},
    }

    await processVerdicts(context)

    expect(mockMysql.query).toHaveBeenCalled()
    expect(context.outputs.mcnVerdicts).toBeDefined()
  })

  it('should process JFM verdicts', async () => {
    const processVerdicts = (await import('../process-verdicts/index.js')).default
    const { parse } = await import('csv-parse/sync')
    parse.mockReturnValue([
      {
        video_id: 'vid1',
        verdict: 'Y',
      },
    ])
    fs.readFile.mockResolvedValue('csv content')

    const context = {
      files: {
        jfmVerdicts: '/path/to/jfm.csv',
      },
      connections: {
        mysql: mockMysql,
      },
      outputs: {},
    }

    await processVerdicts(context)

    expect(mockMysql.query).toHaveBeenCalled()
    expect(context.outputs.jfmVerdicts).toBeDefined()
  })

  it('should skip if no verdict files', async () => {
    const processVerdicts = (await import('../process-verdicts/index.js')).default
    const context = {
      files: {},
      connections: {
        mysql: mockMysql,
      },
      outputs: {},
    }

    await processVerdicts(context)

    expect(mockMysql.query).not.toHaveBeenCalled()
  })
})
