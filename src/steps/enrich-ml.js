import { createReadStream } from 'fs'

import FormData from 'form-data/lib/form_data.js'
import { ObjectId } from 'mongodb'

import { getDatabase } from '../database.js'
import { env } from '../env.js'
import { createAuthedClient } from '../lib/authed-client.js'

/**
 * Enrich unprocessed claims via external ML service (e.g. YT-Validator)
 * Sends CSV file to ML API endpoint, which should return immediately with a task ID,
 * a status of "running", eg. {"status":"running","task_id":"00dbf7d6-f525-43fb-86c9-c47d8804d931"}
 * The ML service will call back our webhook when done.
 */
export default async function enrichML(context) {
  const unprocessedPath = context.outputs.exports?.export_unprocessed_claims?.path
  if (!unprocessedPath) {
    console.log('No unprocessed claims to enrich')
    return
  }

  try {
    if (!env.ML_API_ENDPOINT) {
      throw new Error('ML enrichment disabled: ML_API_ENDPOINT environment variable not set')
    }
    const formData = new FormData()
    formData.append('file', createReadStream(unprocessedPath))
    formData.append('webhook_url', `${env.BASE_URL}/api/ml-webhook`)
    formData.append('pipeline_run_id', context.runId) // TODO: make required ?
    formData.append('skip_validation', String(true))

    // Configure axios with 30s timeout and retry logic
    const mlClient = await createAuthedClient(env.ML_API_ENDPOINT)
    const response = await mlClient.post('/predict', formData, {
      headers: formData.getHeaders(),
      validateStatus: (status) => status >= 200 && status < 300,
    })

    console.log('ML enrichment running: ', response.data)

    // Store task_id immediately, so we can do stuff like cancelling
    if (response.data.task_id) {
      const db = getDatabase()
      await db.collection('pipeline_runs').updateOne(
        { _id: new ObjectId(context.runId) },
        {
          $set: {
            'results.mlEnrichment.task_id': response.data.task_id,
            'results.mlEnrichment.started_at': new Date(),
          },
        }
      )
    }
    return response.data
  } catch (error) {
    // Handle axios-specific errors
    if (error.code === 'ECONNABORTED') {
      // Timeout error
      throw new Error(`ML enrichment failed: Request timed out after ${error.config.timeout}ms`)
    } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      // Endpoint down or unreachable
      throw new Error(
        `ML enrichment failed: Endpoint ${env.ML_API_ENDPOINT} is down or unreachable (${error.code})`
      )
    } else if (error.response) {
      // HTTP error (e.g., 500, 503)
      const status = error.response.status
      const message = error.response.data?.message || 'No additional error details provided'
      throw new Error(`ML enrichment failed: HTTP ${status} - ${message}`)
    } else {
      // Other errors (e.g., invalid FormData, file issues, etc.)
      throw new Error(`ML enrichment failed: ${error.message}`)
    }
  }
}
