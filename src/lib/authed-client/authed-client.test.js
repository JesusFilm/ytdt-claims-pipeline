import axios from 'axios'
import { GoogleAuth } from 'google-auth-library'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('axios')
vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn(),
}))

vi.mock('../../env/index.js', () => ({
  env: {
    K_SERVICE: undefined,
  },
}))

describe('authed-client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should create axios client without auth when K_SERVICE not set', async () => {
    const { createAuthedClient } = await import('../authed-client/index.js')
    axios.create.mockReturnValue({
      get: vi.fn(),
      post: vi.fn(),
    })

    await createAuthedClient('https://api.example.com')

    expect(axios.create).toHaveBeenCalledWith({
      baseURL: 'https://api.example.com',
      headers: {},
      timeout: 30000,
    })
  })

  it('should create axios client with auth when K_SERVICE is set', async () => {
    vi.resetModules()
    vi.doMock('../../env/index.js', () => ({
      env: {
        K_SERVICE: 'test-service',
      },
    }))

    const mockIdTokenClient = {
      idTokenProvider: {
        fetchIdToken: vi.fn().mockResolvedValue('mock-id-token'),
      },
    }
    const mockGoogleAuth = {
      getIdTokenClient: vi.fn().mockResolvedValue(mockIdTokenClient),
    }
    GoogleAuth.mockImplementation(() => mockGoogleAuth)

    const { createAuthedClient } = await import('../authed-client/index.js')
    axios.create.mockReturnValue({
      get: vi.fn(),
      post: vi.fn(),
    })

    await createAuthedClient('https://api.example.com')

    expect(mockGoogleAuth.getIdTokenClient).toHaveBeenCalledWith('https://api.example.com')
    expect(axios.create).toHaveBeenCalledWith({
      baseURL: 'https://api.example.com',
      headers: {
        Authorization: 'Bearer mock-id-token',
      },
      timeout: 30000,
    })
  })

  it('should use custom timeout', async () => {
    const { createAuthedClient } = await import('../authed-client/index.js')
    axios.create.mockReturnValue({
      get: vi.fn(),
      post: vi.fn(),
    })

    await createAuthedClient('https://api.example.com', { timeout: 5000 })

    expect(axios.create).toHaveBeenCalledWith(
      expect.objectContaining({
        timeout: 5000,
      })
    )
  })
})
