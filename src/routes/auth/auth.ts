import express, { type Router } from 'express'

import * as authController from '../../controllers/auth-controller'
import { authenticateRequest } from '../../middleware/auth'

export function createAuthRoutes(): Router {
  const router = express.Router()

  router.get('/google', authController.getAuthUrl)
  router.get('/google/callback', authController.handleCallback)
  router.post('/logout', authenticateRequest, authController.logout)
  router.get('/me', authenticateRequest, authController.getCurrentUser)

  return router
}
