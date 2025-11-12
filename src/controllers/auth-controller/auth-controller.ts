import { type Request, type Response } from 'express'
import { OAuth2Client } from 'google-auth-library'

import { google as googleConfig } from '../../../config/oauth'
import { getDatabase } from '../../database'
import { env } from '../../env'
import { generateToken } from '../../middleware/auth'

const client = new OAuth2Client(
  googleConfig.clientId,
  googleConfig.clientSecret,
  googleConfig.redirectUri
)

export async function getAuthUrl(_req: Request, res: Response): Promise<void> {
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: googleConfig.scopes,
  })

  res.json({ authUrl })
}

export async function handleCallback(req: Request, res: Response): Promise<void> {
  const { code } = req.query

  if (!code || typeof code !== 'string') {
    res.status(400).json({ error: 'No authorization code' })
    return
  }

  try {
    const { tokens } = await client.getToken(code)
    client.setCredentials(tokens)

    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token as string,
      audience: googleConfig.clientId,
    })

    const payload = ticket.getPayload()
    if (!payload) {
      res.status(500).json({ error: 'Failed to get user info' })
      return
    }

    // Verify Workspace domain
    if (
      googleConfig.allowedDomains.length > 0 &&
      !googleConfig.allowedDomains.includes(payload.hd || '')
    ) {
      res.status(403).json({
        error: `Unauthorized domain: ${payload.hd}. Allowed: ${googleConfig.allowedDomains}`,
      })
      return
    }

    // Store or update user
    const db = getDatabase()
    const usersCollection = db.collection('users')

    const user = {
      googleId: payload.sub,
      email: payload.email || '',
      name: payload.name || '',
      picture: payload.picture || '',
      domain: payload.hd || '',
      lastLogin: new Date(),
    }

    await usersCollection.updateOne({ googleId: payload.sub }, { $set: user }, { upsert: true })

    const jwtToken = generateToken({ id: payload.sub, email: payload.email || '' })

    // Redirect to frontend with token
    res.redirect(`${env.FRONTEND_URL}?token=${jwtToken}`)
  } catch (error) {
    console.error('OAuth callback error:', error)
    res.status(500).json({ error: 'Authentication failed' })
  }
}

export async function logout(_req: Request, res: Response): Promise<void> {
  res.json({ message: 'Logged out successfully' })
}

export async function getCurrentUser(req: Request, res: Response): Promise<void> {
  const db = getDatabase()
  const user = await db.collection('users').findOne({ googleId: req.user?.userId })

  if (!user) {
    res.status(404).json({ error: 'User not found' })
    return
  }

  res.json({
    id: user.googleId,
    email: user.email,
    name: user.name,
    picture: user.picture,
  })
}
