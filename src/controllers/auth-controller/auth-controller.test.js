import { OAuth2Client } from 'google-auth-library'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn(),
}))

vi.mock('../../../config/oauth.js', () => ({
  google: {
    clientId: 'test-client-id',
    clientSecret: 'test-secret',
    redirectUri: 'http://localhost/callback',
    scopes: ['email', 'profile'],
    allowedDomains: ['example.com'],
  },
}))

vi.mock('../../database/index.js', () => ({
  getDatabase: vi.fn(),
}))

vi.mock('../../middleware/auth/index.js', () => ({
  generateToken: vi.fn().mockReturnValue('mock-jwt-token'),
}))

vi.mock('../../env/index.js', () => ({
  env: {
    FRONTEND_URL: 'http://localhost:3000',
  },
}))

describe('auth-controller', () => {
  let mockClient
  let mockDb
  let mockCollection

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.resetModules()
    mockCollection = {
      updateOne: vi.fn().mockResolvedValue({}),
      findOne: vi.fn(),
    }
    mockDb = {
      collection: vi.fn().mockReturnValue(mockCollection),
    }
    const { getDatabase } = await import('../../database/index.js')
    getDatabase.mockReturnValue(mockDb)

    mockClient = {
      generateAuthUrl: vi.fn().mockReturnValue('https://accounts.google.com/auth'),
      getToken: vi.fn(),
      setCredentials: vi.fn(),
      verifyIdToken: vi.fn(),
    }
    OAuth2Client.mockImplementation(() => mockClient)
  })

  describe('getAuthUrl', () => {
    it('should generate auth URL', async () => {
      const { getAuthUrl } = await import('../auth-controller/index.js')
      const req = {}
      const res = {
        json: vi.fn().mockReturnThis(),
      }

      await getAuthUrl(req, res)

      expect(mockClient.generateAuthUrl).toHaveBeenCalled()
      expect(res.json).toHaveBeenCalledWith({
        authUrl: 'https://accounts.google.com/auth',
      })
    })
  })

  describe('handleCallback', () => {
    it('should handle valid callback', async () => {
      vi.resetModules()
      const tokens = {
        id_token: 'mock-id-token',
      }
      mockClient.getToken.mockResolvedValue({ tokens })
      const mockTicket = {
        getPayload: vi.fn().mockReturnValue({
          sub: 'user-id',
          email: 'user@example.com',
          name: 'Test User',
          picture: 'https://example.com/pic.jpg',
          hd: 'example.com',
        }),
      }
      mockClient.verifyIdToken.mockResolvedValue(mockTicket)
      OAuth2Client.mockImplementation(() => mockClient)
      const { getDatabase } = await import('../../database/index.js')
      getDatabase.mockReturnValue(mockDb)

      const { handleCallback } = await import('../auth-controller/index.js')
      const req = {
        query: { code: 'auth-code' },
      }
      const res = {
        redirect: vi.fn(),
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      }

      await handleCallback(req, res)

      expect(mockClient.getToken).toHaveBeenCalledWith('auth-code')
      expect(mockCollection.updateOne).toHaveBeenCalled()
      expect(res.redirect).toHaveBeenCalledWith('http://localhost:3000?token=mock-jwt-token')
    })

    it('should reject missing code', async () => {
      const { handleCallback } = await import('../auth-controller/index.js')
      const req = { query: {} }
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      }

      await handleCallback(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({ error: 'No authorization code' })
    })

    it('should reject unauthorized domain', async () => {
      vi.resetModules()
      const tokens = {
        id_token: 'mock-id-token',
      }
      mockClient.getToken.mockResolvedValue({ tokens })
      const mockTicket = {
        getPayload: vi.fn().mockReturnValue({
          sub: 'user-id',
          email: 'user@unauthorized.com',
          hd: 'unauthorized.com',
        }),
      }
      mockClient.verifyIdToken.mockResolvedValue(mockTicket)
      OAuth2Client.mockImplementation(() => mockClient)
      const { getDatabase } = await import('../../database/index.js')
      getDatabase.mockReturnValue(mockDb)

      const { handleCallback } = await import('../auth-controller/index.js')
      const req = {
        query: { code: 'auth-code' },
      }
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      }

      await handleCallback(req, res)

      expect(res.status).toHaveBeenCalledWith(403)
    })
  })

  describe('logout', () => {
    it('should return success message', async () => {
      const { logout } = await import('../auth-controller/index.js')
      const req = {}
      const res = {
        json: vi.fn().mockReturnThis(),
      }

      await logout(req, res)

      expect(res.json).toHaveBeenCalledWith({ message: 'Logged out successfully' })
    })
  })

  describe('getCurrentUser', () => {
    it('should return current user', async () => {
      vi.resetModules()
      mockCollection.findOne.mockResolvedValue({
        googleId: 'user-id',
        email: 'user@example.com',
        name: 'Test User',
        picture: 'https://example.com/pic.jpg',
      })
      OAuth2Client.mockImplementation(() => mockClient)
      const { getDatabase } = await import('../../database/index.js')
      getDatabase.mockReturnValue(mockDb)

      const { getCurrentUser } = await import('../auth-controller/index.js')
      const req = {
        user: { userId: 'user-id' },
      }
      const res = {
        json: vi.fn().mockReturnThis(),
      }

      await getCurrentUser(req, res)

      expect(res.json).toHaveBeenCalledWith({
        id: 'user-id',
        email: 'user@example.com',
        name: 'Test User',
        picture: 'https://example.com/pic.jpg',
      })
    })

    it('should return 404 if user not found', async () => {
      vi.resetModules()
      mockCollection.findOne.mockResolvedValue(null)
      OAuth2Client.mockImplementation(() => mockClient)
      const { getDatabase } = await import('../../database/index.js')
      getDatabase.mockReturnValue(mockDb)

      const { getCurrentUser } = await import('../auth-controller/index.js')
      const req = {
        user: { userId: 'user-id' },
      }
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      }

      await getCurrentUser(req, res)

      expect(res.status).toHaveBeenCalledWith(404)
      expect(res.json).toHaveBeenCalledWith({ error: 'User not found' })
    })
  })
})
