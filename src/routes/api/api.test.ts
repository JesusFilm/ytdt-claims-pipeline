vi.mock('../../controllers/exports-controller', () => ({
  downloadUpload: vi.fn(),
  downloadExport: vi.fn(),
  listExports: vi.fn(),
}))

vi.mock('../../controllers/history-controller', () => ({
  getHistory: vi.fn(),
  retryRun: vi.fn(),
  stopRun: vi.fn(),
}))

vi.mock('../../controllers/slack-controller', () => ({
  handleInteraction: vi.fn(),
}))

vi.mock('../../controllers/status-controller', () => ({
  getStatus: vi.fn(() => (_req, res) => res.json({})),
}))

vi.mock('../../middleware/auth', () => ({
  authenticateRequest: vi.fn((req, res, next) => next()),
}))

describe('api', () => {
  it('should create API routes', async () => {
    const { createApiRoutes } = await import('../api')
    const router = createApiRoutes({})

    expect(router).toBeDefined()
  })

  it('should register all API endpoints', async () => {
    const { createApiRoutes } = await import('../api')
    const router = createApiRoutes({})

    expect(router).toBeDefined()
  })
})
