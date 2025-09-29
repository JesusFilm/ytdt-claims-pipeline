const { getCurrentPipelineStatus, checkAndUpdateCompletion } = require('../pipeline');
const { getDatabase } = require('../database');
const { ObjectId } = require('mongodb');

// Enhanced status with pipeline step details from MongoDB
function getStatus(pipelineStatus) {
  return async (req, res) => {
    try {
      // Get real status from MongoDB instead of in-memory object
      const dbStatus = await getCurrentPipelineStatus();

      const enhancedStatus = {
        ...dbStatus,
        uptime: process.uptime()
      };

      res.json(enhancedStatus);
    } catch (error) {
      console.error('Status error:', error);
      res.status(500).json({ error: 'Failed to get status' });
    }
  };
}

// System health check
function getHealth(req, res) {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
    },
    version: process.env.npm_package_version || '1.0.0'
  });
}

// Save completion result from ML service 
// Update enrich_ml step status to completed (from "running")
async function handleMLWebhook(req, res) {
  try {

    const { task_id, status, error, csv_path, pipeline_run_id } = req.body;
    console.log(`ML webhook received: '${status}' for task ${task_id}, pipeline_run_id: ${pipeline_run_id}`);
    
    const db = getDatabase();
    await db.collection('pipeline_runs').updateOne(
      { _id: new ObjectId(pipeline_run_id) },
      { $set: { 
          'results.mlEnrichment': {
            task_id,
            status,
            error,
            csv_path, 
            updated_at: new Date()
          },
          'completedSteps.$[elem].status': 'completed'
        } 
      },
      { arrayFilters: [{ 'elem.name': 'enrich_ml' }] }
    );
    
    await checkAndUpdateCompletion(new ObjectId(pipeline_run_id));
    res.json({ received: true });

  } catch (error) {
    console.error('ML webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}


module.exports = {
  getStatus,
  getHealth,
  handleMLWebhook,
};