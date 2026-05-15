const express = require('express');
const upload = require('../middleware/upload');
const historyController = require('../controllers/historyController');
const exportsController = require('../controllers/exportsController');
const statusController = require('../controllers/statusController');
const pendingRunController = require('../controllers/pendingRunController');


function createApiRoutes(pipelineStatus) {
  const router = express.Router();

  // History routes
  router.get('/runs/history', historyController.getHistory);
  router.post('/runs/:id/retry', historyController.retryRun);
  router.post('/runs/:id/stop', historyController.stopRun);
  router.post('/runs/:id/steps/:stepName/restart', historyController.restartStep);

  // Pending run routes
  router.get('/pending-run', pendingRunController.getPending);
  router.post('/pending-run', upload.fields([
    { name: 'claims_matter_entertainment', maxCount: 1 },
    { name: 'claims_matter_2', maxCount: 1 }
  ]), pendingRunController.savePending);
  router.delete('/pending-run', pendingRunController.clearPending);

  // Download routes  
  router.get('/uploads/:filename', exportsController.downloadUpload);
  router.get('/exports/run/:runId', exportsController.listExports);
  router.get('/exports/run/:runId/:filename', exportsController.downloadExport);

  // Status routes
  router.get('/status', statusController.getStatus(pipelineStatus));

  return router;
}

module.exports = { createApiRoutes };