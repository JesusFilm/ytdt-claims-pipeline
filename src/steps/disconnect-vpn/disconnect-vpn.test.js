import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../env/index.js', () => ({
  env: {
    SKIP_VPN: false,
  },
}))

describe('disconnect-vpn', () => {
  let mockMysqlPool
  let mockVpnProcess

  beforeEach(() => {
    vi.clearAllMocks()
    mockMysqlPool = {
      end: vi.fn().mockResolvedValue(undefined),
    }
    mockVpnProcess = {
      kill: vi.fn(),
    }
  })

  it('should disconnect MySQL and VPN', async () => {
    const disconnectVPN = (await import('../disconnect-vpn/index.js')).default
    const context = {
      connections: {
        mysql: mockMysqlPool,
        vpnProcess: mockVpnProcess,
      },
    }

    await disconnectVPN(context)

    expect(mockMysqlPool.end).toHaveBeenCalled()
    expect(mockVpnProcess.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('should handle missing MySQL connection', async () => {
    const disconnectVPN = (await import('../disconnect-vpn/index.js')).default
    const context = {
      connections: {
        vpnProcess: mockVpnProcess,
      },
    }

    await disconnectVPN(context)

    expect(mockVpnProcess.kill).toHaveBeenCalled()
  })

  it('should skip VPN kill when SKIP_VPN is true', async () => {
    vi.doMock('../../env/index.js', () => ({
      env: {
        SKIP_VPN: true,
      },
    }))

    const disconnectVPN = (await import('../disconnect-vpn/index.js')).default
    const context = {
      connections: {
        mysql: mockMysqlPool,
      },
    }

    await disconnectVPN(context)

    expect(mockMysqlPool.end).toHaveBeenCalled()
    expect(mockVpnProcess.kill).not.toHaveBeenCalled()
  })
})
