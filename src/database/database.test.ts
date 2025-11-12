import { MongoClient } from 'mongodb'

vi.mock('mongodb', async () => {
  const actual = await vi.importActual<typeof import('mongodb')>('mongodb')
  return {
    ...actual,
    MongoClient: vi.fn(),
  }
})

vi.mock('../env', () => ({
  env: {
    MONGODB_URI: 'mongodb://localhost:27017/test',
  },
}))

describe('database', () => {
  let mockClient: {
    connect: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    db: ReturnType<typeof vi.fn>
  }
  let mockDb: {
    collection: ReturnType<typeof vi.fn>
  }
  let mockCollection: {
    createIndex: ReturnType<typeof vi.fn>
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.resetModules()
    mockCollection = {
      createIndex: vi.fn().mockResolvedValue(undefined),
    }
    mockDb = {
      collection: vi.fn().mockReturnValue(mockCollection),
    }
    mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      db: vi.fn().mockReturnValue(mockDb),
    }
    ;(MongoClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockClient)
  })

  it('should connect to database', async () => {
    vi.resetModules()
    const { connectToDatabase } = await import('../database')
    const db = await connectToDatabase()
    expect(mockClient.connect).toHaveBeenCalled()
    expect(db).toBe(mockDb)
  })

  it('should reuse existing connection', async () => {
    vi.resetModules()
    const { connectToDatabase } = await import('../database')
    await connectToDatabase()
    await connectToDatabase()
    expect(mockClient.connect).toHaveBeenCalledTimes(1)
  })

  it('should create indexes on connect', async () => {
    vi.resetModules()
    const { connectToDatabase } = await import('../database')
    await connectToDatabase()
    expect(mockDb.collection).toHaveBeenCalledWith('pipeline_runs')
    expect(mockCollection.createIndex).toHaveBeenCalled()
  })

  it('should get database instance', async () => {
    vi.resetModules()
    const { connectToDatabase, getDatabase } = await import('../database')
    await connectToDatabase()
    const db = getDatabase()
    expect(db).toBe(mockDb)
  })

  it('should throw error if database not connected', async () => {
    vi.resetModules()
    const { getDatabase } = await import('../database')
    expect(() => getDatabase()).toThrow('Database not connected')
  })

  it('should close connection', async () => {
    vi.resetModules()
    const { connectToDatabase, closeConnection } = await import('../database')
    await connectToDatabase()
    await closeConnection()
    expect(mockClient.close).toHaveBeenCalled()
  })

  it('should handle connection errors', async () => {
    vi.resetModules()
    mockClient.connect.mockRejectedValue(new Error('Connection failed'))
    const { connectToDatabase } = await import('../database')
    await expect(connectToDatabase()).rejects.toThrow('Connection failed')
  })
})
