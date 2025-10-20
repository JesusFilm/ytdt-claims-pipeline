const express = require('express');
const authController = require('../controllers/authController');
const { authenticateRequest } = require('../middleware/auth');


function createAuthRoutes() {
  const router = express.Router();

  router.get('/google', authController.getAuthUrl);
  router.get('/google/callback', authController.handleCallback);
  router.post('/logout', authenticateRequest, authController.logout);
  router.get('/me', authenticateRequest, authController.getCurrentUser);

  return router;
}

module.exports = { createAuthRoutes };
