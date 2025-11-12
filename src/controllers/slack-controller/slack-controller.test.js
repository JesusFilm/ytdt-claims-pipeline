import { ObjectId } from 'mongodb'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../database/index.js', () => ({
  getDatabase: vi.fn(),
}))

vi.mock('../../pipeline/index.js', () => ({
  runPipeline: vi.fn(),
}))

vi.mock('../../env/index.js', () => ({
  env: {
    SLACK_SIGNING_SECRET: 'test-secret',
  },
}))

describe('slack-controller', () => {
  let mockDb
  let mockCollection

  beforeEach(async () => {
    vi.clearAllMocks()
    // Ensure env mock is active before importing
    vi.doMock('../../env/index.js', () => ({
      env: {
        SLACK_SIGNING_SECRET: 'test-secret',
      },
    }))
    vi.resetModules()
    mockCollection = {
      findOne: vi.fn(),
    }
    mockDb = {
      collection: vi.fn().mockReturnValue(mockCollection),
    }
    const { getDatabase } = await import('../../database/index.js')
    getDatabase.mockReturnValue(mockDb)
  })

  describe('handleInteraction', () => {
    it('should handle rerun pipeline action', async () => {
      const { handleInteraction } = await import('../slack-controller/index.js')
      const { runPipeline } = await import('../../pipeline/index.js')
      runPipeline.mockResolvedValue({ success: true })
      const runId = new ObjectId()
      mockCollection.findOne.mockResolvedValue({
        _id: runId,
        files: {},
      })
      const { getDatabase } = await import('../../database/index.js')
      getDatabase.mockReturnValue(mockDb)

      const req = {
        body: {
          payload: JSON.stringify({
            actions: [
              {
                action_id: 'rerun_pipeline',
                value: runId.toString(),
              },
            ],
          }),
        },
      }
      const res = {
        json: vi.fn().mockReturnThis(),
      }

      await handleInteraction(req, res)

      expect(res.json).toHaveBeenCalledWith({
        text: 'Rerunning pipeline...',
        replace_original: false,
      })
    })

    it('should return error if Slack not configured', async () => {
      vi.doMock('../../env/index.js', () => ({
        env: {
          SLACK_SIGNING_SECRET: undefined,
        },
      }))
      vi.resetModules()

      const { handleInteraction } = await import('../slack-controller/index.js')
      const req = {
        body: {
          payload: JSON.stringify({
            actions: [{ action_id: 'rerun_pipeline', value: 'test-id' }],
          }),
        },
      }
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      }

      await handleInteraction(req, res)

      expect(res.status).toHaveBeenCalledWith(500)
    })

    it('should return error if run not found', async () => {
      mockCollection.findOne.mockResolvedValue(null)
      const { getDatabase } = await import('../../database/index.js')
      getDatabase.mockReturnValue(mockDb)

      const { handleInteraction } = await import('../slack-controller/index.js')
      const runId = new ObjectId()
      const req = {
        body: {
          payload: JSON.stringify({
            actions: [
              {
                action_id: 'rerun_pipeline',
                value: runId.toString(),
              },
            ],
          }),
        },
      }
      const res = {
        json: vi.fn().mockReturnThis(),
        status: vi.fn().mockReturnThis(),
      }

      await handleInteraction(req, res)

      expect(res.json).toHaveBeenCalled()
      const callArgs = res.json.mock.calls[0]
      expect(callArgs[0]).toEqual({ text: 'Run not found' })
    })

    it('should handle unknown action', async () => {
      const { handleInteraction } = await import('../slack-controller/index.js')
      const req = {
        body: {
          payload: JSON.stringify({
            actions: [{ action_id: 'unknown_action', value: 'test' }],
          }),
        },
      }
      const res = {
        json: vi.fn().mockReturnThis(),
        status: vi.fn().mockReturnThis(),
      }

      await handleInteraction(req, res)

      expect(res.json).toHaveBeenCalled()
      const callArgs = res.json.mock.calls[0]
      expect(callArgs[0]).toEqual({ text: 'Unknown action' })
    })
  })
})
