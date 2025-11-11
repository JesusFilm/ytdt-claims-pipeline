import jwt from 'jsonwebtoken'

import { env } from '../../env/index.js'

const JWT_EXPIRY = '7d'

export function generateToken(user) {
  return jwt.sign({ userId: user.id, email: user.email }, env.JWT_SECRET, {
    expiresIn: JWT_EXPIRY,
  })
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, env.JWT_SECRET)
  } catch {
    return null
  }
}

export function authenticateRequest(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' })
  }

  const token = authHeader.substring(7)
  const decoded = verifyToken(token)

  if (!decoded) {
    return res.status(401).json({ error: 'Invalid token' })
  }

  req.user = decoded
  next()
}
