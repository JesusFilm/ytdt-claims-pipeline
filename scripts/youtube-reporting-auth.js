/**
 * One-time OAuth sign-in for the daily claims ingest.
 *
 *   node scripts/youtube-reporting-auth.js <desktop-client.json> <token-out.json>
 *
 * Open the printed URL in a browser signed in as a content-manager user
 * (media@jesusfilm.org). Writes an authorized-user token file (mode 0600) for
 * YT_REPORTING_TOKEN_FILE. The token itself is never printed.
 */
const fs = require('fs');
const http = require('http');
const { google } = require('googleapis');
const { SCOPES } = require('../src/lib/youtubeReporting');

const [clientFile, tokenFile] = process.argv.slice(2);
if (!clientFile || !tokenFile) {
  console.error('usage: node scripts/youtube-reporting-auth.js <desktop-client.json> <token-out.json>');
  process.exit(1);
}

const client = JSON.parse(fs.readFileSync(clientFile, 'utf8'));
const { client_id: clientId, client_secret: clientSecret } = client.installed || {};
if (!clientId || !clientSecret) {
  console.error('Expected a Desktop app ("installed") OAuth client file');
  process.exit(1);
}

const server = http.createServer();
server.listen(0, '127.0.0.1', () => {
  const redirectUri = `http://127.0.0.1:${server.address().port}`;
  const oauth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const url = oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'select_account consent',
    scope: SCOPES,
    login_hint: process.env.YT_REPORTING_LOGIN_HINT
  });
  console.log(`Open this URL in the browser signed in as the content-manager user:\n\n${url}\n`);

  server.on('request', async (req, res) => {
    const params = new URL(req.url, redirectUri).searchParams;
    if (!params.get('code') && !params.get('error')) {
      res.writeHead(404).end();
      return;
    }
    try {
      if (params.get('error')) throw new Error(params.get('error'));
      const { tokens } = await oauth.getToken(params.get('code'));
      if (!tokens.refresh_token) throw new Error('No refresh token returned; revoke the app and sign in again');

      const body = JSON.stringify({
        type: 'authorized_user',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: tokens.refresh_token,
        scopes: SCOPES
      }, null, 2);
      fs.writeFileSync(tokenFile, body, { mode: 0o600 });
      fs.chmodSync(tokenFile, 0o600);

      res.end('Authorized. You can close this tab.');
      console.log(`Token saved to ${tokenFile} (0600)`);
    } catch (error) {
      res.end(`Sign-in failed: ${error.message}`);
      console.error('Sign-in failed:', error.message);
      process.exitCode = 1;
    } finally {
      server.close();
    }
  });
});
