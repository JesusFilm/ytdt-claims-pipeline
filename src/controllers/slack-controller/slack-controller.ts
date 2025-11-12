import { type Request, type Response } from 'express'
import { ObjectId } from 'mongodb'

import { getDatabase } from '../../database'
import { env } from '../../env'
import { runPipeline } from '../../pipeline'

export async function handleInteraction(req: Request, res: Response): Promise<void> {
  if (!env.SLACK_SIGNING_SECRET) {
    res.status(500).json({ error: 'Slack not configured' })
    return
  }

  console.log('Received Slack interaction')

  const payload = JSON.parse(req.body.payload as string)
  const action = payload.actions[0]
  console.log('Action ID:', action.action_id)

  if (action.action_id === 'rerun_pipeline') {
    const runId = action.value

    try {
      const db = getDatabase()
      const run = await db.collection('pipeline_runs').findOne({
        _id: new ObjectId(runId),
      })

      if (!run) {
        res.json({ text: 'Run not found' })
        return
      }

      // Acknowledge immediately
      res.json({
        text: `Rerunning pipeline...`,
        replace_original: false,
      })

      // Trigger rerun asynchronously
      runPipeline(run.files, {}, runId).catch((err) => {
        console.error('Pipeline rerun failed:', err)
      })
    } catch (err) {
      console.error('Interaction error:', err)
      res.json({ text: 'Failed to rerun pipeline' })
      return
    }
  } else {
    res.json({ text: 'Unknown action' })
  }
}
