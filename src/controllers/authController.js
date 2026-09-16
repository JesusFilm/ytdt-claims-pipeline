const { OAuth2Client } = require('google-auth-library');
const { google: googleConfig } = require('../../config/oauth');
const { generateToken } = require('../middleware/auth');
const { getDatabase } = require('../database');
const { raiseAlert, clearAlert } = require('../lib/serviceAlerts');


const client = new OAuth2Client(
  googleConfig.clientId,
  googleConfig.clientSecret,
  googleConfig.redirectUri
);

// Where the browser may be sent after login. FRONTEND_URL is always allowed;
// FRONTEND_URL_ALLOWLIST adds comma-separated origins for local dev and
// preview deploys.
//
// This list is the whole security boundary: the return origin arrives from the
// client via the OAuth `state` parameter, and we append a session token to it.
// Honouring an unlisted origin would hand that token to whoever asked, so an
// unrecognised value must fall back to FRONTEND_URL rather than be trusted.
function allowedOrigins() {
  return [process.env.FRONTEND_URL, ...(process.env.FRONTEND_URL_ALLOWLIST || '').split(',')]
    .map(url => (url || '').trim())
    .filter(Boolean);
}

function resolveRedirect(requested) {
  const fallback = process.env.FRONTEND_URL;
  if (!requested) return fallback;

  let candidate;
  try {
    candidate = new URL(requested);
  } catch {
    return fallback; // not a URL at all
  }

  const match = allowedOrigins().find(allowed => {
    try {
      return new URL(allowed).origin === candidate.origin;
    } catch {
      return false;
    }
  });

  if (!match) {
    console.warn(`Rejected OAuth redirect to unlisted origin: ${candidate.origin}`);
    return fallback;
  }
  // Return the allowlisted entry, not the client's string, so a matching
  // origin cannot smuggle in a path or query of its choosing.
  return match;
}

async function getAuthUrl(req, res) {
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: googleConfig.scopes,
    // Carried through Google and handed back to the callback untouched, so the
    // browser returns to whichever console started the login.
    state: resolveRedirect(req.query.redirect_uri),
  });

  res.json({ authUrl });
}

const LOGIN_ALERT = 'console-login';

// Google's OAuth errors arrive as strings in a few shapes depending on where
// they were raised, so match on what they say rather than on a status code.
const CONFIG_FAILURES = [
  'invalid_client',          // client id/secret wrong or the client was deleted
  'unauthorized_client',
  'redirect_uri_mismatch',   // the console's origin is not registered
  'invalid_grant',           // clock skew, or a code reused/expired
  'access_denied',
  'Token used too late',
  'Wrong recipient',         // audience mismatch: clientId no longer matches
  'No pem found',            // Google's signing keys unreachable
];

function isConfigFailure(error) {
  const haystack = [
    error?.message,
    error?.response?.data?.error,
    error?.response?.data?.error_description
  ].filter(Boolean).join(' ');
  return CONFIG_FAILURES.some(needle => haystack.includes(needle));
}

function describeLoginError(error) {
  return error?.response?.data?.error_description
    || error?.response?.data?.error
    || error?.message
    || 'unknown error';
}

async function handleCallback(req, res) {
  const { code } = req.query;

  if (!code) {
    return res.status(400).json({ error: 'No authorization code' });
  }

  try {
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: googleConfig.clientId
    });

    const payload = ticket.getPayload();

    // Verify Workspace domain
    if (googleConfig.allowedDomains.length > 0 && !googleConfig.allowedDomains.includes(payload.hd)) {
      return res.status(403).json({ error: `Unauthorized domain: ${payload.hd}. Allowed: ${googleConfig.allowedDomains}` });
    }

    // Store or update user
    const db = getDatabase();
    const usersCollection = db.collection('users');

    const user = {
      googleId: payload.sub,
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
      domain: payload.hd,
      lastLogin: new Date()
    };

    await usersCollection.updateOne(
      { googleId: payload.sub },
      { $set: user },
      { upsert: true }
    );

    const jwtToken = generateToken({ id: payload.sub, email: payload.email });

    // Redirect to frontend with token. `state` is re-validated rather than
    // trusted: it round-tripped through the browser and could have been
    // tampered with.
    const target = resolveRedirect(req.query.state);
    await clearAlert(LOGIN_ALERT);
    res.redirect(`${target}?token=${jwtToken}`);

  } catch (error) {
    console.error('OAuth callback error:', error);

    // Only config-class failures are worth waking anyone for: Google rejecting
    // our client, a bad redirect URI, an unverifiable token. A stranger failing
    // the domain check is handled above with a 403 and stays out of Slack —
    // the app is public, so alerting on those would be noise and a nuisance
    // vector at once.
    if (isConfigFailure(error)) {
      await raiseAlert(LOGIN_ALERT,
        `:lock: *Console sign-in is broken*\n${describeLoginError(error)}\n` +
        `Nobody can sign in to the console until this is fixed. Individual users ` +
        `being refused for their domain do not appear here.`);
    }

    res.status(500).json({ error: 'Authentication failed' });
  }
}

async function logout(req, res) {
  res.json({ message: 'Logged out successfully' });
}

async function getCurrentUser(req, res) {
  const db = getDatabase();
  const user = await db.collection('users').findOne({ googleId: req.user.userId });

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({
    id: user.googleId,
    email: user.email,
    name: user.name,
    picture: user.picture
  });
}

// isConfigFailure is exported for scripts/test-service-alerts.js: deciding which
// failures wake someone is the part worth pinning down in a test.
module.exports = { getAuthUrl, handleCallback, logout, getCurrentUser, isConfigFailure };