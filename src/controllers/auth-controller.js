import { OAuth2Client } from 'google-auth-library'

import { google as googleConfig } from '../../config/oauth.js'
import { getDatabase } from '../database.js'
import { env } from '../env.js'
import { generateToken } from '../middleware/auth.js'

const client = new OAuth2Client(
  googleConfig.clientId,
  googleConfig.clientSecret,
  googleConfig.redirectUri
)

async function getAuthUrl(req, res) {
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: googleConfig.scopes,
  })

  res.json({ authUrl })
}

async function handleCallback(req, res) {
  const { code } = req.query

  if (!code) {
    return res.status(400).json({ error: 'No authorization code' })
  }

  try {
    const { tokens } = await client.getToken(code)
    client.setCredentials(tokens)

    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: googleConfig.clientId,
    })

    const payload = ticket.getPayload()

    // Verify Workspace domain
    if (
      googleConfig.allowedDomains.length > 0 &&
      !googleConfig.allowedDomains.includes(payload.hd)
    ) {
      return res.status(403).json({
        error: `Unauthorized domain: ${payload.hd}. Allowed: ${googleConfig.allowedDomains}`,
      })
    }

    // Store or update user
    const db = getDatabase()
    const usersCollection = db.collection('users')

    const user = {
      googleId: payload.sub,
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
      domain: payload.hd,
      lastLogin: new Date(),
    }

    await usersCollection.updateOne({ googleId: payload.sub }, { $set: user }, { upsert: true })

    const jwtToken = generateToken({ id: payload.sub, email: payload.email })

    // Redirect to frontend with token
    res.redirect(`${env.FRONTEND_URL}?token=${jwtToken}`)
  } catch (error) {
    console.error('OAuth callback error:', error)
    res.status(500).json({ error: 'Authentication failed' })
  }
}

async function logout(req, res) {
  res.json({ message: 'Logged out successfully' })
}

async function getCurrentUser(req, res) {
  const db = getDatabase()
  const user = await db.collection('users').findOne({ googleId: req.user.userId })

  if (!user) {
    return res.status(404).json({ error: 'User not found' })
  }

  res.json({
    id: user.googleId,
    email: user.email,
    name: user.name,
    picture: user.picture,
  })
}

export { getAuthUrl, handleCallback, logout, getCurrentUser }
