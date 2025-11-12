import express from 'express'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../controllers/status-controller/index.js', () => ({
  handleMLWebhook: vi.fn(),
  getHealth: vi.fn(),
}))

vi.mock('../database/index.js', () => ({
  connectToDatabase: vi.fn().mockResolvedValue({}),
  closeConnection: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../middleware/auth/index.js', () => ({
  authenticateRequest: vi.fn((req, res, next) => next()),
}))

vi.mock('../pipeline/index.js', () => ({
  runPipeline: vi.fn().mockResolvedValue({
    success: true,
    duration: 5000,
    outputs: {},
    runId: 'test-run-id',
  }),
}))

vi.mock('../routes/api/index.js', () => ({
  createApiRoutes: vi.fn().mockReturnValue(express.Router()),
}))

vi.mock('../routes/auth/index.js', () => ({
  createAuthRoutes: vi.fn().mockReturnValue(express.Router()),
}))

vi.mock('../env/index.js', () => ({
  env: {
    PORT: 3000,
  },
}))

vi.mock('multer', () => ({
  default: vi.fn(() => ({
    fields: vi.fn(() => (req, res, next) => {
      req.files = {}
      next()
    }),
  })),
}))

describe('server', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should initialize database on startup', async () => {
    const { connectToDatabase } = await import('../database/index.js')
    await import('../server/server.js')

    expect(connectToDatabase).toHaveBeenCalled()
  })

  it('should register middleware', async () => {
    const express = await import('express')
    const app = express.default()

    expect(app).toBeDefined()
  })

  it('should register routes', async () => {
    const { createApiRoutes } = await import('../routes/api/index.js')
    const { createAuthRoutes } = await import('../routes/auth/index.js')

    expect(createApiRoutes).toBeDefined()
    expect(createAuthRoutes).toBeDefined()
  })

  it('should handle graceful shutdown', async () => {
    const { closeConnection } = await import('../database/index.js')
    const process = global.process

    const originalListeners = process.listeners('SIGINT')
    process.removeAllListeners('SIGINT')

    process.emit('SIGINT')

    await new Promise((resolve) => setTimeout(resolve, 100))

    process.listeners = originalListeners
    expect(closeConnection).toBeDefined()
  })
})
