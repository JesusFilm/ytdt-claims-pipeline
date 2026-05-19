module.exports = {
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI || `${process.env.BASE_URL}/api/auth/google/callback`,
    scopes: [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ],
    allowedDomains: process.env.GOOGLE_WORKSPACE_DOMAINS
      ? process.env.GOOGLE_WORKSPACE_DOMAINS.split(',').map(d => d.trim())
      : [] // ie., 'jesusfilm.org,p2c.com'
  }
}