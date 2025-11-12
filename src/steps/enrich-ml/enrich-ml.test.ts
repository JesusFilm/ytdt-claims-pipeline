import { createReadStream } from 'fs'

import FormData from 'form-data/lib/form_data'
import { ObjectId } from 'mongodb'

vi.mock('fs', () => ({
  createReadStream: vi.fn(),
}))

vi.mock('form-data/lib/form_data', () => ({
  default: vi.fn(),
}))

vi.mock('../../database', () => ({
  getDatabase: vi.fn(),
}))

vi.mock('../../lib/authed-client', () => ({
  createAuthedClient: vi.fn(),
}))

vi.mock('../../env', () => ({
  env: {
    ML_API_ENDPOINT: 'https://ml.example.com',
    BASE_URL: 'http://localhost:3000',
  },
}))

describe('enrich-ml', () => {
  let mockDb: {
    collection: ReturnType<typeof vi.fn>
  }
  let mockCollection: {
    updateOne: ReturnType<typeof vi.fn>
  }
  let mockClient: {
    post: ReturnType<typeof vi.fn>
  }
  let mockFormData: {
    append: ReturnType<typeof vi.fn>
    getHeaders: ReturnType<typeof vi.fn>
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.resetModules()
    mockCollection = {
      updateOne: vi.fn().mockResolvedValue({}),
    }
    mockDb = {
      collection: vi.fn().mockReturnValue(mockCollection),
    }
    const { getDatabase } = await import('../../database')
    ;(getDatabase as ReturnType<typeof vi.fn>).mockReturnValue(mockDb)

    mockClient = {
      post: vi.fn().mockResolvedValue({
        data: { task_id: 'task-123', status: 'running' },
      }),
    }
    const { createAuthedClient } = await import('../../lib/authed-client')
    ;(createAuthedClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient)

    mockFormData = {
      append: vi.fn(),
      getHeaders: vi.fn().mockReturnValue({ 'content-type': 'multipart/form-data' }),
    }
    ;(FormData as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockFormData)
    ;(createReadStream as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      pipe: vi.fn(),
    })
  })

  it('should send ML enrichment request', async () => {
    vi.resetModules()
    const { getDatabase } = await import('../../database')
    ;(getDatabase as ReturnType<typeof vi.fn>).mockReturnValue(mockDb)
    const { createAuthedClient } = await import('../../lib/authed-client')
    ;(createAuthedClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient)
    ;(FormData as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockFormData)
    ;(createReadStream as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      pipe: vi.fn(),
    })

    const enrichML = (await import('../enrich-ml')).default
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
    const enrichML = (await import('../enrich-ml')).default
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
    vi.doMock('../../env', () => ({
      env: {
        ML_API_ENDPOINT: undefined,
        BASE_URL: 'http://localhost:3000',
      },
    }))

    const enrichML = (await import('../enrich-ml')).default
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
    const { getDatabase } = await import('../../database')
    ;(getDatabase as ReturnType<typeof vi.fn>).mockReturnValue(mockDb)
    const { createAuthedClient } = await import('../../lib/authed-client')
    const timeoutError = new Error('timeout') as Error & {
      code?: string
      config?: { timeout?: number }
    }
    timeoutError.code = 'ECONNABORTED'
    timeoutError.config = { timeout: 30000 }
    ;(mockClient.post as ReturnType<typeof vi.fn>).mockRejectedValue(timeoutError)
    ;(createAuthedClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient)
    ;(FormData as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockFormData)
    ;(createReadStream as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      pipe: vi.fn(),
    })

    const enrichML = (await import('../enrich-ml')).default
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
