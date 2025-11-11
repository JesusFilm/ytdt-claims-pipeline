import { ObjectId } from 'mongodb'

import { getDatabase } from '../database.js'
import { env } from '../env.js'
import { runPipeline } from '../pipeline.js'

const SLACK_SIGNING_SECRET = env.SLACK_SIGNING_SECRET

export async function handleInteraction(req, res) {
  console.log('Received Slack interaction')

  if (!SLACK_SIGNING_SECRET) {
    return res.status(500).json({ error: 'Slack not configured' })
  }

  const payload = JSON.parse(req.body.payload)
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
        return res.json({ text: 'Run not found' })
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
      return res.json({ text: 'Failed to rerun pipeline' })
    }
  } else {
    res.json({ text: 'Unknown action' })
  }
}
