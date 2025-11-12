import { ObjectId } from 'mongodb'

import type { Request, Response } from 'express'

vi.mock('../../database', () => ({
  getDatabase: vi.fn(),
}))

vi.mock('../../pipeline', () => ({
  getCurrentPipelineStatus: vi.fn(),
  syncRunState: vi.fn(),
}))

vi.mock('../../lib/authed-client', () => ({
  createAuthedClient: vi.fn(),
}))

vi.mock('../../lib/drive-upload', () => ({
  getOrCreateFolder: vi.fn(),
  uploadFile: vi.fn(),
}))

vi.mock('../../lib/utils', () => ({
  generateRunFolderName: vi.fn().mockReturnValue('20240115103000'),
}))

vi.mock('../../env', () => ({
  env: {
    ML_API_ENDPOINT: 'https://ml.example.com',
    GOOGLE_DRIVE_NAME: 'test-drive',
    BASE_URL: 'http://localhost:3000',
  },
}))

vi.mock('../../version', () => ({
  VERSION: '1.0.0',
}))

describe('status-controller', () => {
  let mockDb: {
    collection: ReturnType<typeof vi.fn>
  }
  let mockCollection: {
    findOne: ReturnType<typeof vi.fn>
    updateOne: ReturnType<typeof vi.fn>
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    mockCollection = {
      findOne: vi.fn(),
      updateOne: vi.fn().mockResolvedValue({}),
    }
    mockDb = {
      collection: vi.fn().mockReturnValue(mockCollection),
    }
    const { getDatabase } = await import('../../database')
    ;(getDatabase as ReturnType<typeof vi.fn>).mockReturnValue(mockDb)
  })

  describe('getStatus', () => {
    it('should return pipeline status', async () => {
      const { getStatus } = await import('../status-controller')
      const { getCurrentPipelineStatus } = await import('../../pipeline')
      ;(getCurrentPipelineStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        running: false,
        status: 'idle',
        currentStep: null,
        progress: 0,
        steps: [],
      })

      const req = {} as Request
      const res = {
        json: vi.fn().mockReturnThis(),
      } as unknown as Response

      const handler = getStatus({})
      await handler(req, res)

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          running: false,
          status: 'idle',
          uptime: expect.any(Number),
        })
      )
    })
  })

  describe('getHealth', () => {
    it('should return health status', async () => {
      const { getHealth } = await import('../status-controller')
      const { createAuthedClient } = await import('../../lib/authed-client')
      const mockClient = {
        get: vi.fn().mockResolvedValue({}),
      }
      ;(createAuthedClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient)

      const req = {} as Request
      const res = {
        json: vi.fn().mockReturnThis(),
      } as unknown as Response

      getHealth(req, res)
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ok',
          uptime: expect.any(Number),
          version: '1.0.0',
        })
      )
    })

    it('should return degraded status if ML service unhealthy', async () => {
      const { getHealth } = await import('../status-controller')
      const { createAuthedClient } = await import('../../lib/authed-client')
      const mockClient = {
        get: vi.fn().mockRejectedValue(new Error('Connection failed')),
      }
      ;(createAuthedClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient)

      const req = {} as Request
      const res = {
        json: vi.fn().mockReturnThis(),
      } as unknown as Response

      getHealth(req, res)
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(res.json).toHaveBeenCalled()
      const callArgs = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(callArgs[0].status).toBe('degraded')
      expect(callArgs[0].enrich_ml_status).toBe('unhealthy')
    })
  })

  describe('handleMLWebhook', () => {
    it('should handle successful ML webhook', async () => {
      const { handleMLWebhook } = await import('../status-controller')
      const runId = new ObjectId()
      ;(mockCollection.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({
        _id: runId,
        startTime: new Date(),
        startedSteps: [
          {
            name: 'enrich_ml',
            timestamp: new Date(Date.now() - 5000),
          },
        ],
      })

      const req = {
        body: {
          task_id: 'task-123',
          status: 'completed',
          csv_path: '/path/to/results.csv',
          num_results: 100,
          pipeline_run_id: runId.toString(),
        },
      } as Request
      const res = {
        json: vi.fn().mockReturnThis(),
      } as unknown as Response

      await handleMLWebhook(req, res)

      expect(mockCollection.updateOne).toHaveBeenCalled()
      expect(res.json).toHaveBeenCalledWith({
        received: true,
        pipeline_run_id: runId.toString(),
      })
    })

    it('should handle failed ML webhook', async () => {
      const { handleMLWebhook } = await import('../status-controller')
      const runId = new ObjectId()
      ;(mockCollection.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({
        _id: runId,
        startTime: new Date(),
        startedSteps: [
          {
            name: 'enrich_ml',
            timestamp: new Date(),
          },
        ],
      })

      const req = {
        body: {
          task_id: 'task-123',
          status: 'failed',
          error: 'Processing error',
          pipeline_run_id: runId.toString(),
        },
      } as Request
      const res = {
        json: vi.fn().mockReturnThis(),
        status: vi.fn().mockReturnThis(),
      } as unknown as Response

      await handleMLWebhook(req, res)

      expect(mockCollection.updateOne).toHaveBeenCalled()
      expect(res.json).toHaveBeenCalled()
    })
  })
})
