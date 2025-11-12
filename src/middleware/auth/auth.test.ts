import jwt from 'jsonwebtoken'

import type { Request, Response, NextFunction } from 'express'

vi.mock('jsonwebtoken')
vi.mock('../../env', () => ({
  env: {
    JWT_SECRET: 'test-secret',
  },
}))

describe('auth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('generateToken', () => {
    it('should generate token for user', async () => {
      const { generateToken } = await import('../auth')
      ;(jwt.sign as ReturnType<typeof vi.fn>).mockReturnValue('mock-token')
      const token = generateToken({ id: '123', email: 'test@example.com' })
      expect(jwt.sign).toHaveBeenCalledWith(
        { userId: '123', email: 'test@example.com' },
        'test-secret',
        { expiresIn: '7d' }
      )
      expect(token).toBe('mock-token')
    })
  })

  describe('verifyToken', () => {
    it('should verify valid token', async () => {
      const { verifyToken } = await import('../auth')
      ;(jwt.verify as ReturnType<typeof vi.fn>).mockReturnValue({
        userId: '123',
        email: 'test@example.com',
      })
      const decoded = verifyToken('valid-token')
      expect(jwt.verify).toHaveBeenCalledWith('valid-token', 'test-secret')
      expect(decoded).toEqual({ userId: '123', email: 'test@example.com' })
    })

    it('should return null for invalid token', async () => {
      const { verifyToken } = await import('../auth')
      ;(jwt.verify as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('Invalid token')
      })
      const decoded = verifyToken('invalid-token')
      expect(decoded).toBeNull()
    })
  })

  describe('authenticateRequest', () => {
    it('should authenticate valid token', async () => {
      const { authenticateRequest } = await import('../auth')
      ;(jwt.verify as ReturnType<typeof vi.fn>).mockReturnValue({
        userId: '123',
        email: 'test@example.com',
      })
      const req = {
        headers: { authorization: 'Bearer valid-token' },
        user: undefined,
      } as unknown as Request
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as unknown as Response
      const next = vi.fn() as NextFunction

      authenticateRequest(req, res, next)

      expect(req.user).toEqual({ userId: '123', email: 'test@example.com' })
      expect(next).toHaveBeenCalled()
    })

    it('should reject missing token', async () => {
      const { authenticateRequest } = await import('../auth')
      const req = { headers: {} } as Request
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as unknown as Response
      const next = vi.fn() as NextFunction

      authenticateRequest(req, res, next)

      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({ error: 'No token provided' })
      expect(next).not.toHaveBeenCalled()
    })

    it('should reject invalid token format', async () => {
      const { authenticateRequest } = await import('../auth')
      const req = {
        headers: { authorization: 'InvalidFormat token' },
      } as Request
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as unknown as Response
      const next = vi.fn() as NextFunction

      authenticateRequest(req, res, next)

      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({ error: 'No token provided' })
      expect(next).not.toHaveBeenCalled()
    })

    it('should reject invalid token', async () => {
      const { authenticateRequest } = await import('../auth')
      ;(jwt.verify as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('Invalid token')
      })
      const req = {
        headers: { authorization: 'Bearer invalid-token' },
      } as Request
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as unknown as Response
      const next = vi.fn() as NextFunction

      authenticateRequest(req, res, next)

      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid token' })
      expect(next).not.toHaveBeenCalled()
    })
  })
})
