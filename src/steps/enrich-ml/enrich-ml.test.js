import { createReadStream } from 'fs'

import FormData from 'form-data/lib/form_data.js'
import { ObjectId } from 'mongodb'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('fs', () => ({
  createReadStream: vi.fn(),
}))

vi.mock('form-data/lib/form_data.js', () => ({
  default: vi.fn(),
}))

vi.mock('../../database/index.js', () => ({
  getDatabase: vi.fn(),
}))

vi.mock('../../lib/authed-client/index.js', () => ({
  createAuthedClient: vi.fn(),
}))

vi.mock('../../env/index.js', () => ({
  env: {
    ML_API_ENDPOINT: 'https://ml.example.com',
    BASE_URL: 'http://localhost:3000',
  },
}))

describe('enrich-ml', () => {
  let mockDb
  let mockCollection
  let mockClient
  let mockFormData

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.resetModules()
    mockCollection = {
      updateOne: vi.fn().mockResolvedValue({}),
    }
    mockDb = {
      collection: vi.fn().mockReturnValue(mockCollection),
    }
    const { getDatabase } = await import('../../database/index.js')
    getDatabase.mockReturnValue(mockDb)

    mockClient = {
      post: vi.fn().mockResolvedValue({
        data: { task_id: 'task-123', status: 'running' },
      }),
    }
    const { createAuthedClient } = await import('../../lib/authed-client/index.js')
    createAuthedClient.mockResolvedValue(mockClient)

    mockFormData = {
      append: vi.fn(),
      getHeaders: vi.fn().mockReturnValue({ 'content-type': 'multipart/form-data' }),
    }
    FormData.mockImplementation(() => mockFormData)
    createReadStream.mockReturnValue({ pipe: vi.fn() })
  })

  it('should send ML enrichment request', async () => {
    vi.resetModules()
    const { getDatabase } = await import('../../database/index.js')
    getDatabase.mockReturnValue(mockDb)
    const { createAuthedClient } = await import('../../lib/authed-client/index.js')
    createAuthedClient.mockResolvedValue(mockClient)
    FormData.mockImplementation(() => mockFormData)
    createReadStream.mockReturnValue({ pipe: vi.fn() })

    const enrichML = (await import('../enrich-ml/index.js')).default
    const runId = new ObjectId()
    const context = {
      outputs: {
        exports: {
          export_unprocessed_claims: {
            path: '/path/to/unprocessed.csv',
          },
        },
      },
      runId: runId.toString(),
    }

    await enrichML(context)

    expect(mockFormData.append).toHaveBeenCalledWith('file', expect.anything())
    expect(mockFormData.append).toHaveBeenCalledWith(
      'webhook_url',
      'http://localhost:3000/api/ml-webhook'
    )
    expect(mockClient.post).toHaveBeenCalled()
    expect(mockCollection.updateOne).toHaveBeenCalled()
  })

  it('should skip if no unprocessed claims', async () => {
    const enrichML = (await import('../enrich-ml/index.js')).default
    const context = {
      outputs: {
        exports: {},
      },
    }

    await enrichML(context)

    expect(mockClient.post).not.toHaveBeenCalled()
  })

  it('should throw error if ML_API_ENDPOINT not set', async () => {
    vi.resetModules()
    vi.doMock('../../env/index.js', () => ({
      env: {
        ML_API_ENDPOINT: undefined,
        BASE_URL: 'http://localhost:3000',
      },
    }))

    const enrichML = (await import('../enrich-ml/index.js')).default
    const context = {
      outputs: {
        exports: {
          export_unprocessed_claims: {
            path: '/path/to/unprocessed.csv',
          },
        },
      },
    }

    await expect(enrichML(context)).rejects.toThrow('ML enrichment disabled')
  })

  it('should handle timeout errors', async () => {
    vi.resetModules()
    const { getDatabase } = await import('../../database/index.js')
    getDatabase.mockReturnValue(mockDb)
    const { createAuthedClient } = await import('../../lib/authed-client/index.js')
    const timeoutError = new Error('timeout')
    timeoutError.code = 'ECONNABORTED'
    timeoutError.config = { timeout: 30000 }
    mockClient.post.mockRejectedValue(timeoutError)
    createAuthedClient.mockResolvedValue(mockClient)
    FormData.mockImplementation(() => mockFormData)
    createReadStream.mockReturnValue({ pipe: vi.fn() })

    const enrichML = (await import('../enrich-ml/index.js')).default
    const context = {
      outputs: {
        exports: {
          export_unprocessed_claims: {
            path: '/path/to/unprocessed.csv',
          },
        },
      },
    }

    await expect(enrichML(context)).rejects.toThrow()
  })
})
