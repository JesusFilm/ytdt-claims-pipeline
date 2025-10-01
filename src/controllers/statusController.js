const { format } = require('date-fns');
const axios = require('axios');
const path = require('path');
const fs = require('fs'); 

const { getOrCreateFolder, uploadFile } = require('../lib/driveUpload');
const { getCurrentPipelineStatus, updatePipelineResults } = require('../pipeline');
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

    const { task_id, status, error, csv_path, num_results, pipeline_run_id } = req.body;
    console.log(`ML webhook received: '${status}' for task ${task_id}, pipeline_run_id: ${pipeline_run_id}`);
    
    const db = getDatabase();

    // Find enrich_ml step to calculate duration
    const run = await db.collection('pipeline_runs').findOne({ _id: new ObjectId(pipeline_run_id) });
    const enrichStep = run?.startedSteps?.find(s => s.name === 'enrich_ml');
    const duration = enrichStep?.timestamp ? Date.now() - new Date(enrichStep.timestamp).getTime() : 0;
    const folderName = format(run.startTime, 'yyyyMMddHHmmss');
    const fileName = `${task_id}.csv`

    // Upload CSV to Drive if successful and Drive is configured
    let driveUpload = null;
    if (status === 'completed' && csv_path && process.env.GOOGLE_DRIVE_NAME) {
      try {

        // Download CSV file from ML service locally
        const response = await axios.get(csv_path, { responseType: 'stream' });
        const tempPath = path.join(process.cwd(), 'data', 'exports', folderName, fileName);
        const writer = fs.createWriteStream(tempPath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });

        // Now upload to Drive
        const folderId = await getOrCreateFolder(folderName, process.env.GOOGLE_DRIVE_NAME);
        driveUpload = await uploadFile(tempPath, folderId, num_results);
        console.log(`ML result uploaded to Drive: ${driveUpload.path}`);

      } catch (uploadError) {
        console.error('Drive upload failed:', uploadError.message);
      }
    }

    // Set ML result and mark enrich_ml step as completed
    await db.collection('pipeline_runs').updateOne(
      { _id: new ObjectId(pipeline_run_id) },
      { $set: { 
          'results.mlEnrichment': {
            task_id,
            status,
            error,
            path: csv_path, 
            rows: num_results,
            name: fileName,
            driveUpload,
            updated_at: new Date(),
          },
          'startedSteps.$[elem].status': 'completed',
          'startedSteps.$[elem].duration': duration
        } 
      },
      { arrayFilters: [{ 'elem.name': 'enrich_ml' }] }
    );
    
    await updatePipelineResults(new ObjectId(pipeline_run_id));
    res.json({ received: true, pipeline_run_id });

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