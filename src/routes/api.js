import express from 'express'

import * as exportsController from '../controllers/exports-controller.js'
import * as historyController from '../controllers/history-controller.js'
import * as slackController from '../controllers/slack-controller.js'
import * as statusController from '../controllers/status-controller.js'

export function createApiRoutes(pipelineStatus) {
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
