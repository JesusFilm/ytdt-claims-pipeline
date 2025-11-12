import express, { type Router } from 'express'

import * as exportsController from '../../controllers/exports-controller'
import * as historyController from '../../controllers/history-controller'
import * as slackController from '../../controllers/slack-controller'
import * as statusController from '../../controllers/status-controller'

export function createApiRoutes(pipelineStatus: unknown): Router {
  const router = express.Router()

  // History routes
  router.get('/runs/history', historyController.getHistory)
  router.post('/runs/:id/retry', historyController.retryRun)
  router.post('/runs/:id/stop', historyController.stopRun)

  // Download routes
  router.get('/uploads/:filename', exportsController.downloadUpload)
  router.get('/exports/run/:runId', exportsController.listExports)
  router.get('/exports/run/:runId/:filename', exportsController.downloadExport)

  // Status routes
  router.get('/status', statusController.getStatus(pipelineStatus))

  // Slack interaction route
  router.post('/slack/interactions', slackController.handleInteraction)

  return router
}
