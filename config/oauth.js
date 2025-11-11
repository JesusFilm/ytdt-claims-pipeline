import { env } from '../src/env.js'

export const google = {
  clientId: env.GOOGLE_CLIENT_ID,
  clientSecret: env.GOOGLE_CLIENT_SECRET,
  redirectUri: env.GOOGLE_REDIRECT_URI || `${env.BASE_URL}/api/auth/google/callback`,
  scopes: [
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ],
  allowedDomains: env.GOOGLE_WORKSPACE_DOMAINS
    ? env.GOOGLE_WORKSPACE_DOMAINS.split(',').map((d) => d.trim())
    : [],
}
