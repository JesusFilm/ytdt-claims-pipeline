require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { runPipeline } = require('./pipeline');
const { createApiRoutes } = require('./routes/api');
const { connectToDatabase, closeConnection } = require('./database');
const { createAuthRoutes } = require('./routes/auth');
const { authenticateRequest } = require('./middleware/auth');
const { handleMLWebhook } = require('./controllers/statusController')

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.urlencoded({ extended: true })); 
app.use(express.json());

// File upload config
const upload = multer({
  dest: 'data/uploads/',
  limits: { fileSize: 1024 * 1024 * 1000 } // 1GB
});

// Store current pipeline status
let pipelineStatus = {
  running: false,
  status: 'idle',
  startTime: null,
  error: null
};

// Initialize database connection
async function initializeApp() {
  try {
    await connectToDatabase();
    console.log('Database connected successfully');
  } catch (error) {
    console.error('Failed to connect to database:', error);
    process.exit(1);
  }
}

// Main pipeline endpoint
app.post('/api/run',
  upload.fields([
    { name: 'claims', maxCount: 1 },
    { name: 'mcn_verdicts', maxCount: 1 },
    { name: 'jfm_verdicts', maxCount: 1 }
  ]),
  async (req, res) => {

    if (pipelineStatus.running) {
      return res.status(409).json({
        error: 'Pipeline already running',
        status: pipelineStatus.status
      });
    }

    const files = {
      claims: req.files.claims?.[0]?.path,
      claimsSource: req.body.claims_source || 'matter_entertainment',
      mcnVerdicts: req.files.mcn_verdicts?.[0]?.path,
      jfmVerdicts: req.files.jfm_verdicts?.[0]?.path
    };

    // Start pipeline
    pipelineStatus = {
      running: true,
      status: 'starting',
      startTime: Date.now(),
      error: null
    };

    // Run pipeline in background
    runPipeline(files)
      .then(async (result) => {
        pipelineStatus = {
          running: false,
          status: 'completed',
          startTime: null,
          error: null,
          result
        };
      })
      .catch(async (error) => {
        pipelineStatus = {
          running: false,
          status: 'failed',
          startTime: null,
          error: error.message
        };
      });

    res.json({
      message: 'Pipeline started',
      files: {
        claims: req.files.claims?.[0]?.originalname,
        mcnVerdicts: req.files.mcn_verdicts?.[0]?.originalname,
        jfmVerdicts: req.files.jfm_verdicts?.[0]?.originalname
      }
    });
  });

// Mount ML webhook route (no auth required for server-to-server callback)
app.post('/api/ml-webhook', handleMLWebhook);

// Mount & Protect API routes
app.use('/api/auth', createAuthRoutes());
app.use('/api', authenticateRequest, createApiRoutes(pipelineStatus));

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await closeConnection();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  await closeConnection();
  process.exit(0);
});

// Start server
async function startServer() {
  await initializeApp();

  app.listen(PORT, () => {
    console.log(`API running on port ${PORT}`);
  });
}

startServer().catch(console.error);