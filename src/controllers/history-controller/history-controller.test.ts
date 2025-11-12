import { ObjectId } from 'mongodb'

import type { Request, Response } from 'express'

vi.mock('../../database', () => ({
  getDatabase: vi.fn(),
}))

vi.mock('../../pipeline', () => ({
  runPipeline: vi.fn(),
  syncRunState: vi.fn(),
}))

vi.mock('../../lib/authed-client', () => ({
  createAuthedClient: vi.fn(),
}))

vi.mock('../../env', () => ({
  env: {
    ML_API_ENDPOINT: 'https://ml.example.com',
  },
}))

describe('history-controller', () => {
  let mockDb: {
    collection: ReturnType<typeof vi.fn>
  }
  let mockCollection: {
    find: ReturnType<typeof vi.fn>
    findOne: ReturnType<typeof vi.fn>
    updateOne: ReturnType<typeof vi.fn>
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    mockCollection = {
      find: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      findOne: vi.fn(),
      updateOne: vi.fn().mockResolvedValue({}),
    }
    mockDb = {
      collection: vi.fn().mockReturnValue(mockCollection),
    }
    const { getDatabase } = await import('../../database')
    ;(getDatabase as ReturnType<typeof vi.fn>).mockReturnValue(mockDb)
  })

  describe('getHistory', () => {
    it('should return pipeline history', async () => {
      const { getHistory } = await import('../history-controller')
      const runs = [
        {
          _id: new ObjectId(),
          startTime: new Date(),
          status: 'completed',
          duration: 5000,
          files: {},
          results: {},
          startedSteps: [],
        },
      ]
      ;(mockCollection.find().sort().limit().toArray as ReturnType<typeof vi.fn>).mockResolvedValue(
        runs
      )

      const req = {} as Request
      const res = {
        json: vi.fn().mockReturnThis(),
      } as unknown as Response

      await getHistory(req, res)

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          runs: expect.any(Array),
          stats: expect.objectContaining({
            total: expect.any(Number),
            successful: expect.any(Number),
            failed: expect.any(Number),
            avgDuration: expect.any(Number),
          }),
        })
      )
    })
  })

  describe('retryRun', () => {
    it('should retry failed run', async () => {
      const { retryRun } = await import('../history-controller')
      const { runPipeline } = await import('../../pipeline')
      const runId = new ObjectId()
      ;(mockCollection.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({
        _id: runId,
        status: 'failed',
        files: {},
      })
      ;(runPipeline as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true })

      const req = {
        params: { id: runId.toString() },
      } as Request
      const res = {
        json: vi.fn().mockReturnThis(),
      } as unknown as Response

      await retryRun(req, res)

      expect(mockCollection.updateOne).toHaveBeenCalled()
      expect(res.json).toHaveBeenCalledWith({
        message: 'Pipeline retry started',
        runId: runId.toString(),
      })
    })

    it('should reject retry for non-failed runs', async () => {
      const { retryRun } = await import('../history-controller')
      const runId = new ObjectId()
      ;(mockCollection.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({
        _id: runId,
        status: 'completed',
      })

      const req = {
        params: { id: runId.toString() },
      } as Request
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as unknown as Response

      await retryRun(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
    })

    it('should return 404 if run not found', async () => {
      const { retryRun } = await import('../history-controller')
      ;(mockCollection.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null)

      const req = {
        params: { id: new ObjectId().toString() },
      } as Request
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as unknown as Response

      await retryRun(req, res)

      expect(res.status).toHaveBeenCalledWith(404)
    })
  })

  describe('stopRun', () => {
    it('should stop running pipeline', async () => {
      const { stopRun } = await import('../history-controller')
      const { syncRunState } = await import('../../pipeline')
      const runId = new ObjectId()
      ;(mockCollection.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({
        _id: runId,
        status: 'running',
        startTime: new Date(),
        startedSteps: [],
      })

      const req = {
        params: { id: runId.toString() },
      } as Request
      const res = {
        json: vi.fn().mockReturnThis(),
      } as unknown as Response

      await stopRun(req, res)

      expect(mockCollection.updateOne).toHaveBeenCalled()
      expect(syncRunState).toHaveBeenCalled()
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: 'Pipeline stopped',
        })
      )
    })

    it('should return 404 if run not found', async () => {
      const { stopRun } = await import('../history-controller')
      ;(mockCollection.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null)

      const req = {
        params: { id: new ObjectId().toString() },
      } as Request
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as unknown as Response

      await stopRun(req, res)

      expect(res.status).toHaveBeenCalledWith(404)
    })

    it('should reject stop for non-running pipelines', async () => {
      const { stopRun } = await import('../history-controller')
      const runId = new ObjectId()
      ;(mockCollection.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({
        _id: runId,
        status: 'completed',
      })

      const req = {
        params: { id: runId.toString() },
      } as Request
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as unknown as Response

      await stopRun(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
    })
  })
})
