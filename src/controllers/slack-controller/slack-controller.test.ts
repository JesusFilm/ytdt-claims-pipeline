import { ObjectId } from 'mongodb'

import type { Request, Response } from 'express'

vi.mock('../../database', () => ({
  getDatabase: vi.fn(),
}))

vi.mock('../../pipeline', () => ({
  runPipeline: vi.fn(),
}))

vi.mock('../../env', () => ({
  env: {
    SLACK_SIGNING_SECRET: 'test-secret',
  },
}))

describe('slack-controller', () => {
  let mockDb: {
    collection: ReturnType<typeof vi.fn>
  }
  let mockCollection: {
    findOne: ReturnType<typeof vi.fn>
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    // Ensure env mock is active before importing
    vi.doMock('../../env', () => ({
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
    const { getDatabase } = await import('../../database')
    ;(getDatabase as ReturnType<typeof vi.fn>).mockReturnValue(mockDb)
  })

  describe('handleInteraction', () => {
    it('should handle rerun pipeline action', async () => {
      const { handleInteraction } = await import('../slack-controller')
      const { runPipeline } = await import('../../pipeline')
      ;(runPipeline as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true })
      const runId = new ObjectId()
      ;(mockCollection.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({
        _id: runId,
        files: {},
      })
      const { getDatabase } = await import('../../database')
      ;(getDatabase as ReturnType<typeof vi.fn>).mockReturnValue(mockDb)

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
      } as Request
      const res = {
        json: vi.fn().mockReturnThis(),
      } as unknown as Response

      await handleInteraction(req, res)

      expect(res.json).toHaveBeenCalledWith({
        text: 'Rerunning pipeline...',
        replace_original: false,
      })
    })

    it('should return error if Slack not configured', async () => {
      vi.doMock('../../env', () => ({
        env: {
          SLACK_SIGNING_SECRET: undefined,
        },
      }))
      vi.resetModules()

      const { handleInteraction } = await import('../slack-controller')
      const req = {
        body: {
          payload: JSON.stringify({
            actions: [{ action_id: 'rerun_pipeline', value: 'test-id' }],
          }),
        },
      } as Request
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as unknown as Response

      await handleInteraction(req, res)

      expect(res.status).toHaveBeenCalledWith(500)
    })

    it('should return error if run not found', async () => {
      ;(mockCollection.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null)
      const { getDatabase } = await import('../../database')
      ;(getDatabase as ReturnType<typeof vi.fn>).mockReturnValue(mockDb)

      const { handleInteraction } = await import('../slack-controller')
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
      } as Request
      const res = {
        json: vi.fn().mockReturnThis(),
        status: vi.fn().mockReturnThis(),
      } as unknown as Response

      await handleInteraction(req, res)

      expect(res.json).toHaveBeenCalled()
      const callArgs = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(callArgs[0]).toEqual({ text: 'Run not found' })
    })

    it('should handle unknown action', async () => {
      const { handleInteraction } = await import('../slack-controller')
      const req = {
        body: {
          payload: JSON.stringify({
            actions: [{ action_id: 'unknown_action', value: 'test' }],
          }),
        },
      } as Request
      const res = {
        json: vi.fn().mockReturnThis(),
        status: vi.fn().mockReturnThis(),
      } as unknown as Response

      await handleInteraction(req, res)

      expect(res.json).toHaveBeenCalled()
      const callArgs = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(callArgs[0]).toEqual({ text: 'Unknown action' })
    })
  })
})
