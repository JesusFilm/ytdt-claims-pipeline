import { type Request, type Response, type NextFunction } from 'express'
import jwt from 'jsonwebtoken'

import { env } from '../../env'

const JWT_EXPIRY = '7d'

export function generateToken(user: { id: string; email: string }) {
  return jwt.sign({ userId: user.id, email: user.email }, env.JWT_SECRET, {
    expiresIn: JWT_EXPIRY,
  })
}

export function verifyToken(token: string) {
  try {
    return jwt.verify(token, env.JWT_SECRET) as { userId: string; email: string }
  } catch {
    return null
  }
}

export function authenticateRequest(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided' })
    return
  }

  const token = authHeader.substring(7)
  const decoded = verifyToken(token)

  if (!decoded) {
    res.status(401).json({ error: 'Invalid token' })
    return
  }

  req.user = decoded
  next()
}
