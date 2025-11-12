import { spawn } from 'child_process'

import mysql from 'mysql2/promise'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

vi.mock('mysql2/promise', () => ({
  default: {
    createPool: vi.fn(),
  },
}))

vi.mock('../../env/index.js', () => ({
  env: {
    SKIP_VPN: false,
    VPN_CONFIG_FILE: '/path/to/config.ovpn',
    MYSQL_HOST: 'localhost',
    MYSQL_USER: 'user',
    MYSQL_PASSWORD: 'pass',
    MYSQL_DATABASE: 'testdb',
  },
}))

describe('connect-vpn', () => {
  let mockVpnProcess
  let mockMysqlPool

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockVpnProcess = {
      on: vi.fn(),
      kill: vi.fn(),
    }
    spawn.mockReturnValue(mockVpnProcess)
    mockMysqlPool = {
      query: vi.fn().mockResolvedValue([{}]),
      end: vi.fn().mockResolvedValue(undefined),
    }
    mysql.createPool.mockResolvedValue(mockMysqlPool)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should connect VPN when SKIP_VPN is false', async () => {
    const connectVPN = (await import('../connect-vpn/index.js')).default
    mockVpnProcess.on.mockImplementation((event, _callback) => {
      if (event === 'error') {
        // Don't call error callback
      }
    })

    const context = {
      connections: {},
    }

    const promise = connectVPN(context)
    // Fast-forward timers to resolve the VPN connection
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(2000)
    await promise

    expect(spawn).toHaveBeenCalledWith(
      'openvpn',
      expect.arrayContaining(['--config', '/path/to/config.ovpn'])
    )
    expect(context.connections.vpnProcess).toBeDefined()
  })

  it('should skip VPN when SKIP_VPN is true', async () => {
    vi.doMock('../../env/index.js', () => ({
      env: {
        SKIP_VPN: true,
        MYSQL_HOST: 'localhost',
        MYSQL_USER: 'user',
        MYSQL_PASSWORD: 'pass',
        MYSQL_DATABASE: 'testdb',
      },
    }))
    vi.resetModules()

    const connectVPN = (await import('../connect-vpn/index.js')).default
    const context = {
      connections: {},
    }

    await connectVPN(context)

    expect(spawn).not.toHaveBeenCalled()
    expect(mysql.createPool).toHaveBeenCalled()
  })

  it('should connect to MySQL', async () => {
    const connectVPN = (await import('../connect-vpn/index.js')).default
    const context = {
      connections: {},
    }

    const promise = connectVPN(context)
    // Fast-forward timers
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(2000)
    await promise

    expect(mysql.createPool).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'localhost',
        user: 'user',
        password: 'pass',
        database: 'testdb',
      })
    )
    expect(mockMysqlPool.query).toHaveBeenCalledWith('SELECT 1')
  })

  it('should handle MySQL connection errors', async () => {
    const connectVPN = (await import('../connect-vpn/index.js')).default
    mockMysqlPool.query.mockRejectedValue(new Error('Connection failed'))

    const context = {
      connections: {},
    }

    // Start the promise and attach error handler immediately to prevent unhandled rejection
    let errorCaught = null
    const promise = connectVPN(context)
    promise.catch((error) => {
      errorCaught = error
    })

    // Fast-forward timers to resolve VPN connection
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(2000)

    // Process all pending timers
    await vi.runAllTimersAsync()

    // Check that the promise rejects with the expected error
    await expect(promise).rejects.toThrow('Connection failed')
    expect(errorCaught).toBeTruthy()
    expect(errorCaught.message).toBe('Connection failed')
  })
})
