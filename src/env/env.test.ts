describe('env', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env.SKIP_ENV_VALIDATION = 'true'
  })

  it('should export env object', async () => {
    process.env.SKIP_ENV_VALIDATION = 'true'
    const { env } = await import('../env')
    expect(env).toBeDefined()
    expect(typeof env).toBe('object')
  })

  it('should have default values when SKIP_ENV_VALIDATION is true', async () => {
    process.env.SKIP_ENV_VALIDATION = 'true'
    const { env } = await import('../env')
    expect(env).toBeDefined()
  })

  it('should validate required fields when SKIP_ENV_VALIDATION is false', async () => {
    delete process.env.SKIP_ENV_VALIDATION
    const originalEnv = { ...process.env }
    delete process.env.FRONTEND_URL
    delete process.env.MYSQL_HOST

    await expect(async () => {
      vi.resetModules()
      await import('../env')
    }).rejects.toThrow()

    process.env = originalEnv
  })
})
