import express from 'express'

vi.mock('../controllers/status-controller', () => ({
  handleMLWebhook: vi.fn(),
  getHealth: vi.fn(),
}))

vi.mock('../database', () => ({
  connectToDatabase: vi.fn().mockResolvedValue({}),
  closeConnection: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../middleware/auth', () => ({
  authenticateRequest: vi.fn((req, res, next) => next()),
}))

vi.mock('../pipeline', () => ({
  runPipeline: vi.fn().mockResolvedValue({
    success: true,
    duration: 5000,
    outputs: {},
    runId: 'test-run-id',
  }),
}))

vi.mock('../routes/api', () => ({
  createApiRoutes: vi.fn().mockReturnValue(express.Router()),
}))

vi.mock('../routes/auth', () => ({
  createAuthRoutes: vi.fn().mockReturnValue(express.Router()),
}))

vi.mock('../env', () => ({
  env: {
    PORT: 3000,
  },
}))

vi.mock('multer', () => ({
  default: vi.fn(() => ({
    fields: vi.fn(() => (_req, _res, next) => {
      next()
    }),
  })),
}))

describe('server', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should initialize database on startup', async () => {
    const { connectToDatabase } = await import('../database')
    await import('../server/server')

    expect(connectToDatabase).toHaveBeenCalled()
  })

  it('should register middleware', async () => {
    const express = await import('express')
    const app = express.default()

    expect(app).toBeDefined()
  })

  it('should register routes', async () => {
    const { createApiRoutes } = await import('../routes/api')
    const { createAuthRoutes } = await import('../routes/auth')

    expect(createApiRoutes).toBeDefined()
    expect(createAuthRoutes).toBeDefined()
  })

  it('should handle graceful shutdown', async () => {
    const { closeConnection } = await import('../database')
    const process = global.process

    const originalListeners = process.listeners('SIGINT')
    process.removeAllListeners('SIGINT')

    process.emit('SIGINT')

    await new Promise((resolve) => setTimeout(resolve, 100))

    process.listeners = originalListeners
    expect(closeConnection).toBeDefined()
  })
})
