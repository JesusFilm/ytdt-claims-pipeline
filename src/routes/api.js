const express = require('express');
const historyController = require('../controllers/historyController');
const exportsController = require('../controllers/exportsController');
const statusController = require('../controllers/statusController');

function createApiRoutes(pipelineStatus) {
  const router = express.Router();

  // History routes
  router.get('/runs/history', historyController.getHistory);
  router.get('/runs/:id/retry', historyController.retryRun);

  // Export routes  
  router.get('/exports', exportsController.listExports);
  router.get('/exports/:filename', exportsController.downloadExport);

  // Mount ML webhook route for YT-Validator callback
  router.post('/ml-webhook', statusController.handleMLWebhook);

  // Status routes
  router.get('/status', statusController.getStatus(pipelineStatus));
  router.get('/health', statusController.getHealth);

  return router;
}

module.exports = { createApiRoutes };