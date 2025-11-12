import { vi } from 'vitest'

export const mockMongoCollection = {
  findOne: vi.fn(),
  find: vi.fn().mockReturnValue({
    sort: vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue([]),
      }),
    }),
  }),
  insertOne: vi.fn(),
  updateOne: vi.fn(),
  createIndex: vi.fn(),
}

export const mockMongoDb = {
  collection: vi.fn().mockReturnValue(mockMongoCollection),
}

export const mockMongoClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  db: vi.fn().mockReturnValue(mockMongoDb),
}

export const mockMysqlPool = {
  query: vi.fn(),
  end: vi.fn().mockResolvedValue(undefined),
}

export const mockExpressRequest = (overrides = {}) => ({
  headers: {},
  query: {},
  params: {},
  body: {},
  user: {},
  files: {},
  ...overrides,
})

export const mockExpressResponse = () => {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    redirect: vi.fn().mockReturnThis(),
    download: vi.fn().mockReturnThis(),
    headersSent: false,
  }
  return res
}

export const mockAxiosInstance = {
  get: vi.fn(),
  post: vi.fn(),
  create: vi.fn().mockReturnThis(),
}

export const mockGoogleAuth = {
  getIdTokenClient: vi.fn().mockResolvedValue({
    idTokenProvider: {
      fetchIdToken: vi.fn().mockResolvedValue('mock-token'),
    },
  }),
}

export const mockOAuth2Client = {
  generateAuthUrl: vi.fn().mockReturnValue('https://accounts.google.com/auth'),
  getToken: vi.fn(),
  setCredentials: vi.fn(),
  verifyIdToken: vi.fn(),
}

export const mockDriveApi = {
  drives: {
    list: vi.fn().mockResolvedValue({
      data: {
        drives: [{ id: 'drive-id', name: 'test-drive' }],
      },
    }),
  },
  files: {
    list: vi.fn().mockResolvedValue({
      data: { files: [] },
    }),
    create: vi.fn().mockResolvedValue({
      data: { id: 'file-id', name: 'test.csv', size: '1000' },
    }),
  },
}

export const mockGoogleApis = {
  drive: vi.fn().mockReturnValue(mockDriveApi),
  auth: {
    GoogleAuth: vi.fn().mockImplementation(() => ({
      getClient: vi.fn().mockResolvedValue({}),
    })),
  },
}

export const mockSlackPayload = {
  actions: [
    {
      action_id: 'rerun_pipeline',
      value: 'test-run-id',
    },
  ],
}

export const mockContext = (overrides = {}) => ({
  files: {},
  options: {},
  connections: {},
  outputs: {},
  status: 'starting',
  startTime: Date.now(),
  runId: 'test-run-id',
  ...overrides,
})
