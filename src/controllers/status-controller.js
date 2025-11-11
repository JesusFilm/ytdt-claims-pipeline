import { createWriteStream } from 'fs'
import path from 'path'

import { ObjectId } from 'mongodb'

import { getDatabase } from '../database.js'
import { env } from '../env.js'
import { createAuthedClient } from '../lib/authted-client.js'
import { getOrCreateFolder, uploadFile } from '../lib/drive-upload.js'
import { generateRunFolderName } from '../lib/utils.js'
import { getCurrentPipelineStatus, syncRunState } from '../pipeline.js'
import { VERSION } from '../version.js'

// Enhanced status with pipeline step details from MongoDB
function getStatus(_pipelineStatus) {
  return async (req, res) => {
    try {
      // Get real status from MongoDB instead of in-memory object
      const dbStatus = await getCurrentPipelineStatus()

      const enhancedStatus = {
        ...dbStatus,
        uptime: process.uptime(),
      }

      res.json(enhancedStatus)
    } catch (error) {
      console.error('Status error:', error)
      res.status(500).json({ error: 'Failed to get status' })
    }
  }
}

// System health check - both this backend and ML service
function getHealth(req, res) {
  const healthCheck = async () => {
    const health = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      },
      version: VERSION,
    }

    // Check ML service
    try {
      if (env.ML_API_ENDPOINT) {
        const mlClient = await createAuthedClient(env.ML_API_ENDPOINT, { timeout: 5000 })
        await mlClient.get('/health')
        health.enrich_ml_status = 'healthy'
      } else {
        health.enrich_ml_status = 'not_configured'
      }
    } catch {
      health.enrich_ml_status = 'unhealthy'
      health.status = 'degraded'
    }
  }

  healthCheck()
    .then((health) => res.json(health))
    .catch((error) => {
      console.error('Health check failed:', error)
      res.status(500).json({ status: 'error', uptime: 0, memory: { used: 0, total: 0 } })
    })
}

// Save completion result from ML service
// Update enrich_ml step status to completed (from "running")
async function handleMLWebhook(req, res) {
  try {
    const { task_id, status, error, csv_path, num_results, pipeline_run_id } = req.body
    console.log(
      `ML webhook received: '${status}' for task ${task_id}, pipeline_run_id: ${pipeline_run_id}`
    )

    const db = getDatabase()

    // Find enrich_ml step to calculate duration
    const run = await db.collection('pipeline_runs').findOne({ _id: new ObjectId(pipeline_run_id) })
    const enrichStep = run?.startedSteps?.find((s) => s.name === 'enrich_ml')
    const duration = enrichStep?.timestamp
      ? Date.now() - new Date(enrichStep.timestamp).getTime()
      : 0
    const folderName = generateRunFolderName(run.startTime)
    const fileName = `unprocessed_claims_${enrichStep.name}.csv`
    const fullCsvUrl = env.ML_API_ENDPOINT ? path.join(env.ML_API_ENDPOINT, csv_path) : csv_path

    // Upload CSV to Drive if successful and Drive is configured
    let driveUpload = null
    if (status === 'completed' && csv_path && env.GOOGLE_DRIVE_NAME && env.ML_API_ENDPOINT) {
      try {
        // Download CSV file from ML service locally
        const mlClient = await createAuthedClient(env.ML_API_ENDPOINT)
        const response = await mlClient.get(csv_path, { responseType: 'stream' })

        const tempPath = path.join(process.cwd(), 'data', 'exports', folderName, fileName)
        const writer = createWriteStream(tempPath)
        response.data.pipe(writer)
        await new Promise((resolve, reject) => {
          writer.on('finish', resolve)
          writer.on('error', reject)
        })

        // Now upload to Drive
        const folderId = await getOrCreateFolder(folderName, env.GOOGLE_DRIVE_NAME)
        driveUpload = await uploadFile(tempPath, folderId, num_results)
        console.log(`ML result uploaded to Drive: ${driveUpload.path}`)
      } catch (uploadError) {
        console.error('Drive upload failed:', uploadError.message)
      }
    }

    // Set ML result and mark enrich_ml step as completed
    await db.collection('pipeline_runs').updateOne(
      { _id: new ObjectId(pipeline_run_id) },
      {
        $set: {
          'results.mlEnrichment': {
            task_id,
            status,
            error,
            path: fullCsvUrl,
            rows: num_results,
            name: fileName,
            driveUpload,
            updated_at: new Date(),
          },
          'startedSteps.$[elem].status': 'completed',
          'startedSteps.$[elem].duration': duration,
        },
      },
      { arrayFilters: [{ 'elem.name': 'enrich_ml' }] }
    )

    await syncRunState(new ObjectId(pipeline_run_id))
    res.json({ received: true, pipeline_run_id })
  } catch (error) {
    console.error('ML webhook error:', error)
    res.status(500).json({ error: 'Webhook processing failed' })
  }
}

export { getStatus, getHealth, handleMLWebhook }
