import 'dotenv/config'
import cors from 'cors'
import express, { type Request, type Response } from 'express'
import multer from 'multer'

import { handleMLWebhook, getHealth } from '../controllers/status-controller'
import { connectToDatabase, closeConnection } from '../database'
import { env } from '../env'
import { authenticateRequest } from '../middleware/auth'
import { runPipeline } from '../pipeline'
import { createApiRoutes } from '../routes/api'
import { createAuthRoutes } from '../routes/auth'

const app = express()

// Middleware
app.use(cors())
app.use(express.urlencoded({ extended: true }))
app.use(express.json())

// File upload config
const upload = multer({
  dest: 'data/uploads/',
  limits: { fileSize: 1024 * 1024 * 5000 }, // 5GB
})

// Store current pipeline status
let pipelineStatus: {
  running: boolean
  status: string
  startTime: number | null
  error: string | null
  result?: unknown
} = {
  running: false,
  status: 'idle',
  startTime: null,
  error: null,
}

// Initialize database connection
async function initializeApp() {
  try {
    await connectToDatabase()
    console.log('Database connected successfully')
  } catch (error) {
    console.error('Failed to connect to database:', error)
    process.exit(1)
  }
}

// Main pipeline endpoint
app.post(
  '/api/run',
  upload.fields([
    { name: 'claims_matter_entertainment', maxCount: 1 },
    { name: 'claims_matter_2', maxCount: 1 },
    { name: 'mcn_verdicts', maxCount: 1 },
    { name: 'jfm_verdicts', maxCount: 1 },
  ]),
  async (req: Request, res: Response) => {
    if (pipelineStatus.running) {
      res.status(409).json({
        error: 'Pipeline already running',
        status: pipelineStatus.status,
      })
      return
    }

    const filesObj = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined
    const files = {
      claims: {
        matter_entertainment: filesObj?.['claims_matter_entertainment']?.[0]?.path,
        matter_2: filesObj?.['claims_matter_2']?.[0]?.path,
      },
      mcnVerdicts: filesObj?.['mcn_verdicts']?.[0]?.path,
      jfmVerdicts: filesObj?.['jfm_verdicts']?.[0]?.path,
    }

    // Start pipeline
    pipelineStatus = {
      running: true,
      status: 'starting',
      startTime: Date.now(),
      error: null,
    }

    // Run pipeline in background
    runPipeline(files)
      .then(async (result) => {
        pipelineStatus = {
          running: false,
          status: 'completed',
          startTime: null,
          error: null,
          result,
        }
      })
      .catch(async (error: Error) => {
        pipelineStatus = {
          running: false,
          status: 'failed',
          startTime: null,
          error: error.message,
        }
      })

    res.json({
      message: 'Pipeline started',
      files: {
        claims_matter_entertainment: filesObj?.['claims_matter_entertainment']?.[0]?.originalname,
        claims_matter_2: filesObj?.['claims_matter_2']?.[0]?.originalname,
        mcnVerdicts: filesObj?.['mcn_verdicts']?.[0]?.originalname,
        jfmVerdicts: filesObj?.['jfm_verdicts']?.[0]?.originalname,
      },
    })
  }
)

// Mount public routes (server-to-server callback, health check)
app.post('/api/ml-webhook', handleMLWebhook)
app.get('/api/health', getHealth)

// Mount & Protect API routes
app.use('/api/auth', createAuthRoutes())
app.use('/api', authenticateRequest, createApiRoutes(pipelineStatus))

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...')
  await closeConnection()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...')
  await closeConnection()
  process.exit(0)
})

// Start server
async function startServer() {
  await initializeApp()

  app.listen(env.PORT, () => {
    console.log(`API running on port ${env.PORT}`)
  })
}

startServer().catch(console.error)
