import fs from 'fs/promises'

vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('csv-stringify/sync', () => ({
  stringify: vi.fn().mockReturnValue('csv,content'),
}))

vi.mock('../../lib/utils', () => ({
  generateRunFolderName: vi.fn().mockReturnValue('20240115103000'),
}))

describe('export-views', () => {
  let mockMysql: {
    query: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockMysql = {
      query: vi.fn().mockResolvedValue([
        [
          { id: 1, name: 'test' },
          { id: 2, name: 'test2' },
        ],
      ]),
    }
  })

  it('should export all views', async () => {
    const exportViews = (await import('../export-views')).default
    const context = {
      connections: {
        mysql: mockMysql,
      },
      startTime: new Date(),
      outputs: {},
    }

    await exportViews(context)

    expect(mockMysql.query).toHaveBeenCalledTimes(3)
    expect(fs.mkdir).toHaveBeenCalled()
    expect(fs.writeFile).toHaveBeenCalled()
    expect(context.outputs.exports).toBeDefined()
  })

  it('should skip empty views', async () => {
    const exportViews = (await import('../export-views')).default
    ;(mockMysql.query as ReturnType<typeof vi.fn>).mockResolvedValue([[]])

    const context = {
      connections: {
        mysql: mockMysql,
      },
      startTime: new Date(),
      outputs: {},
    }

    await exportViews(context)

    expect(fs.writeFile).not.toHaveBeenCalled()
  })

  it('should handle errors', async () => {
    const exportViews = (await import('../export-views')).default
    ;(mockMysql.query as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Database error'))

    const context = {
      connections: {
        mysql: mockMysql,
      },
      startTime: new Date(),
      outputs: {},
    }

    await expect(exportViews(context)).rejects.toThrow('Database error')
  })
})
