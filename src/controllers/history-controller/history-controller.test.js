import { ObjectId } from 'mongodb'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../database/index.js', () => ({
  getDatabase: vi.fn(),
}))

vi.mock('../../pipeline/index.js', () => ({
  runPipeline: vi.fn(),
  syncRunState: vi.fn(),
}))

vi.mock('../../lib/authed-client/index.js', () => ({
  createAuthedClient: vi.fn(),
}))

vi.mock('../../env/index.js', () => ({
  env: {
    ML_API_ENDPOINT: 'https://ml.example.com',
  },
}))

describe('history-controller', () => {
  let mockDb
  let mockCollection

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
    const { getDatabase } = await import('../../database/index.js')
    getDatabase.mockReturnValue(mockDb)
  })

  describe('getHistory', () => {
    it('should return pipeline history', async () => {
      const { getHistory } = await import('../history-controller/index.js')
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
      mockCollection.find().sort().limit().toArray.mockResolvedValue(runs)

      const req = {}
      const res = {
        json: vi.fn().mockReturnThis(),
      }

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
      const { retryRun } = await import('../history-controller/index.js')
      const { runPipeline } = await import('../../pipeline/index.js')
      const runId = new ObjectId()
      mockCollection.findOne.mockResolvedValue({
        _id: runId,
        status: 'failed',
        files: {},
      })
      runPipeline.mockResolvedValue({ success: true })

      const req = {
        params: { id: runId.toString() },
      }
      const res = {
        json: vi.fn().mockReturnThis(),
      }

      await retryRun(req, res)

      expect(mockCollection.updateOne).toHaveBeenCalled()
      expect(res.json).toHaveBeenCalledWith({
        message: 'Pipeline retry started',
        runId: runId.toString(),
      })
    })

    it('should reject retry for non-failed runs', async () => {
      const { retryRun } = await import('../history-controller/index.js')
      const runId = new ObjectId()
      mockCollection.findOne.mockResolvedValue({
        _id: runId,
        status: 'completed',
      })

      const req = {
        params: { id: runId.toString() },
      }
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      }

      await retryRun(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
    })

    it('should return 404 if run not found', async () => {
      const { retryRun } = await import('../history-controller/index.js')
      mockCollection.findOne.mockResolvedValue(null)

      const req = {
        params: { id: new ObjectId().toString() },
      }
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      }

      await retryRun(req, res)

      expect(res.status).toHaveBeenCalledWith(404)
    })
  })

  describe('stopRun', () => {
    it('should stop running pipeline', async () => {
      const { stopRun } = await import('../history-controller/index.js')
      const { syncRunState } = await import('../../pipeline/index.js')
      const runId = new ObjectId()
      mockCollection.findOne.mockResolvedValue({
        _id: runId,
        status: 'running',
        startTime: new Date(),
        startedSteps: [],
      })

      const req = {
        params: { id: runId.toString() },
      }
      const res = {
        json: vi.fn().mockReturnThis(),
      }

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
      const { stopRun } = await import('../history-controller/index.js')
      mockCollection.findOne.mockResolvedValue(null)

      const req = {
        params: { id: new ObjectId().toString() },
      }
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      }

      await stopRun(req, res)

      expect(res.status).toHaveBeenCalledWith(404)
    })

    it('should reject stop for non-running pipelines', async () => {
      const { stopRun } = await import('../history-controller/index.js')
      const runId = new ObjectId()
      mockCollection.findOne.mockResolvedValue({
        _id: runId,
        status: 'completed',
      })

      const req = {
        params: { id: runId.toString() },
      }
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      }

      await stopRun(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
    })
  })
})
