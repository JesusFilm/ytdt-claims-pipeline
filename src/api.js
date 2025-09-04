require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { runPipeline } = require('./pipeline');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
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

// Main endpoint
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

    // Run pipeline in background
    pipelineStatus = {
      running: true,
      status: 'starting',
      startTime: Date.now(),
      error: null
    };

    runPipeline(files)
      .then(result => {
        pipelineStatus = {
          running: false,
          status: 'completed',
          startTime: null,
          error: null,
          result
        };
      })
      .catch(error => {
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

// Status endpoint
app.get('/api/status', (req, res) => {
  res.json(pipelineStatus);
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});