describe('backup-tables', () => {
  let mockMysql: {
    query: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockMysql = {
      query: vi.fn().mockResolvedValue([{}]),
    }
  })

  it('should create backup table', async () => {
    const backupTables = (await import('../backup-tables')).default
    const context = {
      connections: {
        mysql: mockMysql,
      },
    }

    await backupTables(context)

    expect(mockMysql.query).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS youtube_mcn_claims_bkup_')
    )
  })

  it('should handle errors', async () => {
    const backupTables = (await import('../backup-tables')).default
    mockMysql.query.mockRejectedValue(new Error('Database error'))

    const context = {
      connections: {
        mysql: mockMysql,
      },
    }

    await expect(backupTables(context)).rejects.toThrow('Database error')
  })
})
