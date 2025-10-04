const express = require('express');
const historyController = require('../controllers/historyController');
const exportsController = require('../controllers/exportsController');
const statusController = require('../controllers/statusController');

function createApiRoutes(pipelineStatus) {
  const router = express.Router();

  // History routes
  router.get('/runs/history', historyController.getHistory);
  router.post('/runs/:id/retry', historyController.retryRun);

  // Download routes  
  router.get('/uploads/:filename', exportsController.downloadUpload);
  router.get('/exports/run/:runId', exportsController.listExports);
  router.get('/exports/run/:runId/:filename', exportsController.downloadExport);

  // Mount ML webhook route for YT-Validator callback
  router.post('/ml-webhook', statusController.handleMLWebhook);

  // Status routes
  router.get('/status', statusController.getStatus(pipelineStatus));
  router.get('/health', statusController.getHealth);

  return router;
}

module.exports = { createApiRoutes };