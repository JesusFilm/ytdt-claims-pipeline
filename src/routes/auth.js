import express from 'express'

import * as authController from '../controllers/auth-controller.js'
import { authenticateRequest } from '../middleware/auth.js'

export function createAuthRoutes() {
  const router = express.Router()

  router.get('/google', authController.getAuthUrl)
  router.get('/google/callback', authController.handleCallback)
  router.post('/logout', authenticateRequest, authController.logout)
  router.get('/me', authenticateRequest, authController.getCurrentUser)

  return router
}
