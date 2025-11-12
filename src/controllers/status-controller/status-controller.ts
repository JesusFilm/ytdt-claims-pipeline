import { createWriteStream } from 'fs'
import path from 'path'

import { type Request, type Response } from 'express'
import { ObjectId } from 'mongodb'

import { getDatabase } from '../../database'
import { env } from '../../env'
import { createAuthedClient } from '../../lib/authed-client'
import { getOrCreateFolder, uploadFile } from '../../lib/drive-upload'
import { generateRunFolderName } from '../../lib/utils'
import { getCurrentPipelineStatus, syncRunState } from '../../pipeline'
import { VERSION } from '../../version'

// Enhanced status with pipeline step details from MongoDB
export function getStatus(_pipelineStatus: unknown) {
  return async (_req: Request, res: Response): Promise<void> => {
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
export function getHealth(_req: Request, res: Response): void {
  const healthCheck = async () => {
    const health: Record<string, unknown> = {
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

    return health
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
export async function handleMLWebhook(req: Request, res: Response): Promise<void> {
  try {
    const { task_id, status, error, csv_path, num_results, pipeline_run_id } = req.body
    console.log(
      `ML webhook received: '${status}' for task ${task_id}, pipeline_run_id: ${pipeline_run_id}`
    )

    const db = getDatabase()

    // Find enrich_ml step to calculate duration
    const run = await db.collection('pipeline_runs').findOne({ _id: new ObjectId(pipeline_run_id) })
    if (!run) {
      res.status(404).json({ error: 'Run not found' })
      return
    }
    const enrichStep = run.startedSteps?.find((s: { name: string }) => s.name === 'enrich_ml')
    const duration = enrichStep?.timestamp
      ? Date.now() - new Date(enrichStep.timestamp).getTime()
      : 0
    const folderName = generateRunFolderName(run.startTime)
    const fileName = `unprocessed_claims_${enrichStep?.name || 'enrich_ml'}.csv`
    const fullCsvUrl = csv_path
      ? env.ML_API_ENDPOINT
        ? path.join(env.ML_API_ENDPOINT, csv_path)
        : csv_path
      : null

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
        await new Promise<void>((resolve, reject) => {
          writer.on('finish', resolve)
          writer.on('error', reject)
        })

        // Now upload to Drive
        const folderId = await getOrCreateFolder(folderName, env.GOOGLE_DRIVE_NAME)
        driveUpload = await uploadFile(tempPath, folderId, num_results)
        console.log(`ML result uploaded to Drive: ${driveUpload.path}`)
      } catch (uploadError) {
        console.error('Drive upload failed:', (uploadError as Error).message)
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
