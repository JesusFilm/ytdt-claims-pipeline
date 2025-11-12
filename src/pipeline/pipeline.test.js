import { ObjectId } from 'mongodb'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../database/index.js', () => ({
  getDatabase: vi.fn(),
}))

vi.mock('../env/index.js', () => ({
  env: {
    PIPELINE_TIMEOUT_MINUTES: 60,
    GOOGLE_DRIVE_NAME: 'test-drive',
    SLACK_BOT_TOKEN: undefined,
  },
}))

vi.mock('../steps/connect-vpn/index.js', () => ({
  default: vi.fn().mockResolvedValue({ status: 'completed' }),
}))

vi.mock('../steps/disconnect-vpn/index.js', () => ({
  default: vi.fn().mockResolvedValue({ status: 'completed' }),
}))

vi.mock('../steps/validate-input-csvs/index.js', () => ({
  default: vi.fn().mockResolvedValue({ status: 'completed' }),
}))

vi.mock('../steps/backup-tables/index.js', () => ({
  default: vi.fn().mockResolvedValue({ status: 'completed' }),
}))

vi.mock('../steps/process-claims/index.js', () => ({
  default: vi.fn().mockResolvedValue({ status: 'completed' }),
}))

vi.mock('../steps/process-verdicts/index.js', () => ({
  default: vi.fn().mockResolvedValue({ status: 'completed' }),
}))

vi.mock('../steps/export-views/index.js', () => ({
  default: vi.fn().mockResolvedValue({ status: 'completed' }),
}))

vi.mock('../steps/enrich-ml/index.js', () => ({
  default: vi.fn().mockResolvedValue({ status: 'completed' }),
}))

vi.mock('../steps/upload-drive/index.js', () => ({
  default: vi.fn().mockResolvedValue({ status: 'completed' }),
}))

describe('pipeline', () => {
  let mockDb
  let mockCollection

  beforeEach(async () => {
    vi.clearAllMocks()
    mockCollection = {
      insertOne: vi.fn().mockResolvedValue({ insertedId: new ObjectId() }),
      updateOne: vi.fn().mockResolvedValue({}),
      findOne: vi.fn().mockResolvedValue({
        _id: new ObjectId(),
        status: 'running',
        startTime: new Date(),
        startedSteps: [],
      }),
    }
    mockDb = {
      collection: vi.fn().mockReturnValue(mockCollection),
    }
    const { getDatabase } = await import('../database/index.js')
    getDatabase.mockReturnValue(mockDb)
  })

  describe('runPipeline', () => {
    it('should run pipeline with all steps', async () => {
      const { runPipeline } = await import('../pipeline/index.js')
      const files = {
        claims: {
          matter_entertainment: '/path/to/file.csv',
        },
        mcnVerdicts: '/path/to/mcn.csv',
      }

      const result = await runPipeline(files)

      expect(result.success).toBe(true)
      expect(result.runId).toBeDefined()
      expect(mockCollection.insertOne).toHaveBeenCalled()
    })

    it('should skip steps based on conditions', async () => {
      const { runPipeline } = await import('../pipeline/index.js')
      const files = {
        claims: {},
      }

      await runPipeline(files)

      const connectVPN = await import('../steps/connect-vpn/index.js')
      expect(connectVPN.default).toHaveBeenCalled()
    })

    it('should handle step errors', async () => {
      const { runPipeline } = await import('../pipeline/index.js')
      const validateInputCSVs = await import('../steps/validate-input-csvs/index.js')
      validateInputCSVs.default.mockRejectedValue(new Error('Validation failed'))

      const files = {
        claims: {
          matter_entertainment: '/path/to/file.csv',
        },
      }

      await expect(runPipeline(files)).rejects.toThrow('Validation failed')
      expect(mockCollection.updateOne).toHaveBeenCalled()
    })

    it('should retry with existing run ID', async () => {
      const { runPipeline } = await import('../pipeline/index.js')
      const validateInputCSVs = await import('../steps/validate-input-csvs/index.js')
      validateInputCSVs.default.mockResolvedValue({ status: 'completed' })

      const runId = new ObjectId()
      mockCollection.findOne.mockResolvedValue({
        _id: runId,
        status: 'running',
        startTime: new Date(),
        startedSteps: [],
        files: {
          claims: {
            matter_entertainment: '/path/to/file.csv',
          },
        },
      })
      const files = {
        claims: {
          matter_entertainment: '/path/to/file.csv',
        },
      }

      const result = await runPipeline(files, {}, runId.toString())

      expect(result.success).toBe(true)
      expect(mockCollection.updateOne).toHaveBeenCalledWith({ _id: runId }, expect.any(Object))
    })

    it('should stop if pipeline marked as stopped', async () => {
      const { runPipeline } = await import('../pipeline/index.js')
      mockCollection.findOne.mockResolvedValue({
        _id: new ObjectId(),
        status: 'stopped',
        startTime: new Date(),
        startedSteps: [],
      })

      const files = {
        claims: {
          matter_entertainment: '/path/to/file.csv',
        },
      }

      const result = await runPipeline(files)

      expect(result.success).toBe(true)
    })
  })

  describe('getCurrentPipelineStatus', () => {
    it('should return idle status when no runs', async () => {
      const { getCurrentPipelineStatus } = await import('../pipeline/index.js')
      mockCollection.findOne.mockResolvedValue(null)

      const status = await getCurrentPipelineStatus()

      expect(status.running).toBe(false)
      expect(status.status).toBe('idle')
    })

    it('should return running status', async () => {
      const { getCurrentPipelineStatus } = await import('../pipeline/index.js')
      mockCollection.findOne.mockResolvedValue({
        _id: new ObjectId(),
        status: 'running',
        currentStep: 'process_claims',
        startTime: new Date(),
        startedSteps: [
          {
            name: 'connect_vpn',
            status: 'completed',
            timestamp: new Date(),
            duration: 1000,
          },
        ],
      })

      const status = await getCurrentPipelineStatus()

      expect(status.running).toBe(true)
      expect(status.currentStep).toBe('process_claims')
    })
  })

  describe('checkTimeout', () => {
    it('should detect timeout', async () => {
      const { checkTimeout } = await import('../pipeline/index.js')
      const run = {
        startTime: new Date(Date.now() - 61 * 60 * 1000),
      }

      const isTimeout = checkTimeout(run)

      expect(isTimeout).toBe(true)
    })

    it('should not detect timeout for recent runs', async () => {
      const { checkTimeout } = await import('../pipeline/index.js')
      const run = {
        startTime: new Date(Date.now() - 30 * 60 * 1000),
      }

      const isTimeout = checkTimeout(run)

      expect(isTimeout).toBe(false)
    })
  })

  describe('syncRunState', () => {
    it('should mark pipeline as completed', async () => {
      const { syncRunState } = await import('../pipeline/index.js')
      const runId = new ObjectId()
      // Get all steps that should run for the given files (including conditional ones)
      const files = {
        claims: {
          matter_entertainment: '/path/to/file.csv',
        },
      }
      // All steps that should run: connect_vpn, validate_input_csvs, backup_tables,
      // process_claims_matter_entertainment (condition met), export_views,
      // enrich_ml (condition met - GOOGLE_DRIVE_NAME is set), upload_drive
      const allSteps = [
        'connect_vpn',
        'validate_input_csvs',
        'backup_tables',
        'process_claims_matter_entertainment',
        'export_views',
        'enrich_ml',
        'upload_drive',
      ]
      mockCollection.findOne.mockResolvedValue({
        _id: runId,
        status: 'running',
        startTime: new Date(),
        startedSteps: allSteps.map((name) => ({
          name,
          status: 'completed',
        })),
        files,
      })

      await syncRunState(runId, { duration: 5000 })

      expect(mockCollection.updateOne).toHaveBeenCalled()
    })
  })
})
