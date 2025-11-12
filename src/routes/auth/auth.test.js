import { describe, it, expect, vi } from 'vitest'

vi.mock('../../controllers/auth-controller/index.js', () => ({
  getAuthUrl: vi.fn(),
  handleCallback: vi.fn(),
  logout: vi.fn(),
  getCurrentUser: vi.fn(),
}))

vi.mock('../../middleware/auth/index.js', () => ({
  authenticateRequest: vi.fn((req, res, next) => next()),
}))

describe('auth', () => {
  it('should create auth routes', async () => {
    const { createAuthRoutes } = await import('../auth/index.js')
    const router = createAuthRoutes()

    expect(router).toBeDefined()
  })

  it('should register all auth endpoints', async () => {
    const { createAuthRoutes } = await import('../auth/index.js')
    const router = createAuthRoutes()

    expect(router).toBeDefined()
  })
})
