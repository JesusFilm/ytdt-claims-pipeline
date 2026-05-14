const express = require('express');
const historyController = require('../controllers/historyController');
const exportsController = require('../controllers/exportsController');
const statusController = require('../controllers/statusController');
const slackController = require('../controllers/slackController');


function createApiRoutes(pipelineStatus) {
  const router = express.Router();

  // History routes
  router.get('/runs/history', historyController.getHistory);
  router.post('/runs/:id/retry', historyController.retryRun);
  router.post('/runs/:id/stop', historyController.stopRun);
  router.post('/runs/:id/steps/:stepName/restart', historyController.restartStep);

  // Download routes  
  router.get('/uploads/:filename', exportsController.downloadUpload);
  router.get('/exports/run/:runId', exportsController.listExports);
  router.get('/exports/run/:runId/:filename', exportsController.downloadExport);

  // Status routes
  router.get('/status', statusController.getStatus(pipelineStatus));

  // Slack interaction route
  router.post('/slack/interactions', slackController.handleInteraction);
  router.post('/slack/events', slackController.handleEvent);
  router.post('/slack/commands', slackController.handleSlashCommand);

  return router;
}

module.exports = { createApiRoutes };