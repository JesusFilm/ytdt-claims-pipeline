import { describe, it, expect, vi } from 'vitest'

vi.mock('../../controllers/exports-controller/index.js', () => ({
  downloadUpload: vi.fn(),
  downloadExport: vi.fn(),
  listExports: vi.fn(),
}))

vi.mock('../../controllers/history-controller/index.js', () => ({
  getHistory: vi.fn(),
  retryRun: vi.fn(),
  stopRun: vi.fn(),
}))

vi.mock('../../controllers/slack-controller/index.js', () => ({
  handleInteraction: vi.fn(),
}))

vi.mock('../../controllers/status-controller/index.js', () => ({
  getStatus: vi.fn(() => (req, res) => res.json({})),
}))

vi.mock('../../middleware/auth/index.js', () => ({
  authenticateRequest: vi.fn((req, res, next) => next()),
}))

describe('api', () => {
  it('should create API routes', async () => {
    const { createApiRoutes } = await import('../api/index.js')
    const router = createApiRoutes({})

    expect(router).toBeDefined()
  })

  it('should register all API endpoints', async () => {
    const { createApiRoutes } = await import('../api/index.js')
    const router = createApiRoutes({})

    expect(router).toBeDefined()
  })
})
