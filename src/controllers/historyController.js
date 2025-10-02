const { getDatabase } = require('../database');
const { ObjectId } = require('mongodb');


// Get pipeline run history
async function getHistory(req, res) {
  try {
    const db = getDatabase();
    const collection = db.collection('pipeline_runs');
    
    // Get runs sorted by startTime descending, limit to 50
    const runs = await collection
      .find({})
      .sort({ startTime: -1 })
      .limit(50)
      .toArray();
    
    // Convert MongoDB _id to id and format for frontend
    const formattedRuns = runs.map(run => ({
      id: run._id.toString(),
      startTime: run.startTime,
      status: run.status,
      duration: run.duration,
      files: run.files || {},
      results: run.results,
      startedSteps: run.startedSteps || [],
      error: run.error,
    }));
    
    // Calculate stats
    const total = runs.length;
    const successful = runs.filter(r => r.status === 'completed').length;
    const failed = runs.filter(r => r.status === 'failed').length;
    const avgDuration = runs.length > 0 
      ? Math.round(runs.reduce((sum, run) => sum + (run.duration || 0), 0) / runs.length)
      : 0;

    res.json({
      runs: formattedRuns,
      stats: { total, successful, failed, avgDuration }
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
    const originalRun = await collection.findOne({ _id: new ObjectId(runId) });
    
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
  getHistory,
  retryRun
};