vi.mock('../../env', () => ({
  env: {
    SKIP_VPN: false,
  },
}))

describe('disconnect-vpn', () => {
  let mockMysqlPool: {
    end: ReturnType<typeof vi.fn>
  }
  let mockVpnProcess: {
    kill: ReturnType<typeof vi.fn>
  }

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
    const disconnectVPN = (await import('../disconnect-vpn')).default
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
    const disconnectVPN = (await import('../disconnect-vpn')).default
    const context = {
      connections: {
        vpnProcess: mockVpnProcess,
      },
    }

    await disconnectVPN(context)

    expect(mockVpnProcess.kill).toHaveBeenCalled()
  })

  it('should skip VPN kill when SKIP_VPN is true', async () => {
    vi.doMock('../../env', () => ({
      env: {
        SKIP_VPN: true,
      },
    }))

    const disconnectVPN = (await import('../disconnect-vpn')).default
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
