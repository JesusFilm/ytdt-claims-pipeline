require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { runPipeline } = require('./pipeline');
const { connectToDatabase, closeConnection } = require('./database');

const upload = require('./middleware/upload');
const { authenticateRequest } = require('./middleware/auth');

const { getHealth } = require('./controllers/statusController');
const slackController = require('./controllers/slackController');
const { handleMLWebhook } = require('./controllers/statusController')

const { createApiRoutes } = require('./routes/api');
const { createAuthRoutes } = require('./routes/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.urlencoded({ extended: true })); 
app.use(express.json());


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
    { name: 'claims_matter_entertainment', maxCount: 1 },
    { name: 'claims_matter_2', maxCount: 1 },
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
      claims: {
        matter_entertainment: req.files.claims_matter_entertainment?.[0]?.path,
        matter_2: req.files.claims_matter_2?.[0]?.path
      },
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
    runPipeline(files, {}, null, { source: 'ui', user: req.user?.email || 'unknown' })
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
        claims_matter_entertainment: req.files.claims_matter_entertainment?.[0]?.originalname,
        claims_matter_2: req.files.claims_matter_2?.[0]?.originalname,
        mcnVerdicts: req.files.mcn_verdicts?.[0]?.originalname,
        jfmVerdicts: req.files.jfm_verdicts?.[0]?.originalname
      }
    });
  });

// Mount public routes (server-to-server callback, health check)   
app.post('/api/ml-webhook', handleMLWebhook);
app.get('/api/health', getHealth);

// Slack routes (no auth — verified by signing secret instead)
app.post('/api/slack/interactions', slackController.handleInteraction);
app.post('/api/slack/events',       slackController.handleEvent);
app.post('/api/slack/commands',     slackController.handleSlashCommand);

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

  if (process.env.ML_API_ENDPOINT) {
    console.log(`ML service enabled at ${process.env.ML_API_ENDPOINT}`);
  } else {
    console.log('ML service disabled: ML_API_ENDPOINT not set');
  }

  app.listen(PORT, () => {
    console.log(`API running on port ${PORT}`);
  });
}

startServer().catch(console.error);