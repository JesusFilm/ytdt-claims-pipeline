import { type Request, type Response } from 'express'
import { ObjectId } from 'mongodb'

import { getDatabase } from '../../database'
import { env } from '../../env'
import { createAuthedClient } from '../../lib/authed-client'
import { syncRunState, runPipeline } from '../../pipeline'

// Get pipeline run history
export async function getHistory(_req: Request, res: Response): Promise<void> {
  try {
    const db = getDatabase()
    const collection = db.collection('pipeline_runs')

    // Get runs sorted by startTime descending, limit to 50
    const runs = await collection.find({}).sort({ startTime: -1 }).limit(50).toArray()

    // Convert MongoDB _id to id and format for frontend
    const formattedRuns = runs.map((run) => ({
      id: run._id.toString(),
      startTime: run.startTime,
      status: run.status,
      duration: run.duration,
      files: run.files || {},
      results: run.results,
      startedSteps: run.startedSteps || [],
      error: run.error,
    }))

    // Calculate stats
    const total = runs.length
    const successful = runs.filter((r) => r.status === 'completed').length
    const failed = runs.filter((r) => r.status === 'failed').length
    const avgDuration =
      runs.length > 0
        ? Math.round(runs.reduce((sum, run) => sum + (run.duration || 0), 0) / runs.length)
        : 0

    res.json({
      runs: formattedRuns,
      stats: { total, successful, failed, avgDuration },
    })
  } catch (error) {
    console.error('History fetch error:', error)
    res.status(500).json({ error: 'Failed to fetch history' })
  }
}

// Retry a pipeline run
export async function retryRun(req: Request, res: Response): Promise<void> {
  try {
    const db = getDatabase()
    const collection = db.collection('pipeline_runs')

    const runId = req.params.id
    const originalRun = await collection.findOne({ _id: new ObjectId(runId) })

    if (!originalRun) {
      res.status(404).json({ error: 'Run not found' })
      return
    }

    if (originalRun.status !== 'failed' && originalRun.status !== 'timeout') {
      res.status(400).json({
        error: 'Can only retry failed or timed out runs',
      })
      return
    }

    // Reset the run state
    await collection.updateOne(
      { _id: new ObjectId(runId) },
      {
        $set: {
          status: 'running',
          currentStep: 'starting',
          startedSteps: [],
          error: null,
          endTime: null,
          startTime: new Date(),
        },
      }
    )

    // Start pipeline with existing ID
    setImmediate(() => {
      runPipeline(originalRun.files, {}, runId).catch((error) => {
        console.error('Retry pipeline error:', error)
      })
    })

    res.json({
      message: 'Pipeline retry started',
      runId: runId,
    })
  } catch (error) {
    console.error('Retry error:', error)
    res.status(500).json({ error: 'Retry failed' })
  }
}

// Stop a pipeline run
export async function stopRun(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params
    const db = getDatabase()

    const run = await db.collection('pipeline_runs').findOne({
      _id: new ObjectId(id),
    })

    if (!run) {
      res.status(404).json({ error: 'Run not found' })
      return
    }

    if (run.status !== 'running') {
      res.status(400).json({ error: `Cannot stop ${run.status} pipeline` })
      return
    }

    // Stop ML enrichment if running
    const mlTaskId = (run.results as { mlEnrichment?: { task_id?: string } } | undefined)
      ?.mlEnrichment?.task_id
    const mlStep = run.startedSteps?.find((s: { name: string }) => s.name === 'enrich_ml')
    const shouldStopML = mlTaskId && (!mlStep || mlStep.status === 'running')
    if (shouldStopML && env.ML_API_ENDPOINT) {
      try {
        console.log(`Stopping ML task ${mlTaskId}`)
        const mlClient = await createAuthedClient(env.ML_API_ENDPOINT, { timeout: 5000 })
        await mlClient.post(`/stop/${mlTaskId}`)
      } catch (mlError) {
        console.error('Failed to stop ML task:', (mlError as Error).message)
        // Continue with pipeline stop anyway
      }
    }

    // Update run status
    const stoppedAt = new Date()
    const stoppedStep = run.startedSteps?.find((s: { status: string }) => s.status === 'running')
    const stoppedStepName = stoppedStep ? stoppedStep.title || stoppedStep.name : 'unknown step'
    const updateFields: Record<string, unknown> = {
      status: 'stopped',
      endTime: stoppedAt,
      duration: Date.now() - new Date(run.startTime).getTime(),
      error: `Pipeline stopped by user at ${stoppedAt.toLocaleTimeString()} while processing: ${stoppedStepName}`,
    }

    const runningStepIndex = run.startedSteps?.findIndex(
      (s: { status: string }) => s.status === 'running'
    )
    if (runningStepIndex !== -1) {
      updateFields[`startedSteps.${runningStepIndex}.status`] = 'stopped'
    }

    await db
      .collection('pipeline_runs')
      .updateOne({ _id: new ObjectId(id) }, { $set: updateFields })

    await syncRunState(new ObjectId(id))

    res.json({
      success: true,
      message: 'Pipeline stopped',
      mlTaskStopped: !!mlTaskId,
    })
  } catch (error) {
    console.error('Stop run error:', error)
    res.status(500).json({ error: 'Failed to stop pipeline' })
  }
}
