// Simple in-memory storage (replace with database in production)
let pipelineRuns = [];

// Store a completed pipeline run
function storeRun(runData) {
  const run = {
    id: Date.now().toString(),
    timestamp: new Date().toISOString(),
    status: runData.status, // 'completed' | 'failed'
    duration: runData.duration,
    files: runData.files,
    results: runData.results,
    error: runData.error
  };
  
  pipelineRuns.unshift(run); // Add to beginning
  
  // Keep only last 50 runs
  if (pipelineRuns.length > 50) {
    pipelineRuns = pipelineRuns.slice(0, 50);
  }
  
  return run;
}

// Get pipeline run history
function getHistory(req, res) {
  try {
    const stats = {
      total: pipelineRuns.length,
      successful: pipelineRuns.filter(r => r.status === 'completed').length,
      failed: pipelineRuns.filter(r => r.status === 'failed').length,
      avgDuration: pipelineRuns.length > 0 
        ? Math.round(pipelineRuns.reduce((sum, run) => sum + (run.duration || 0), 0) / pipelineRuns.length)
        : 0
    };

    res.json({
      runs: pipelineRuns,
      stats
    });
  } catch (error) {
    console.error('History fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
}

// Retry a pipeline run
async function retryRun(req, res) {
  try {
    const db = getDatabase();
    const collection = db.collection('pipeline_runs');
    
    const runId = req.params.id;
    const originalRun = await collection.findOne({ _id: require('mongodb').ObjectId(runId) });
    
    if (!originalRun) {
      return res.status(404).json({ error: 'Run not found' });
    }
    
    // Return the original files for re-processing
    res.json({ 
      message: 'Retry data retrieved',
      files: originalRun.files 
    });
    
  } catch (error) {
    console.error('Retry error:', error);
    res.status(500).json({ error: 'Retry failed' });
  }
}

module.exports = {
  storeRun,
  getHistory,
  retryRun
};