import fs from 'fs/promises'

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('csv-stringify/sync', () => ({
  stringify: vi.fn().mockReturnValue('csv,content'),
}))

vi.mock('../../lib/utils/index.js', () => ({
  generateRunFolderName: vi.fn().mockReturnValue('20240115103000'),
}))

describe('export-views', () => {
  let mockMysql

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
    const exportViews = (await import('../export-views/index.js')).default
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
    const exportViews = (await import('../export-views/index.js')).default
    mockMysql.query.mockResolvedValue([[]])

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
    const exportViews = (await import('../export-views/index.js')).default
    mockMysql.query.mockRejectedValue(new Error('Database error'))

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
