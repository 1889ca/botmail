/** Contract: OAuth 2.1 authorization server endpoints (metadata, registration, authorize, token) */

import crypto from 'node:crypto';
import { registerClient, findClient, createPendingAuth, consumeAuthCode, createAccessToken } from '../db.js';

const PROVIDERS = {
  github: {
    authUrl: 'https://github.com/login/oauth/authorize',
    scopes: 'read:user',
  },
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    scopes: 'openid email profile',
  },
};

/** GET /.well-known/oauth-authorization-server */
export function metadata(req, res) {
  const base = process.env.BASE_URL;
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
}

/** GET /.well-known/oauth-protected-resource */
export function resourceMetadata(req, res) {
  const base = process.env.BASE_URL;
  res.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
  });
}

/** POST /oauth/register — Dynamic client registration (RFC 7591) */
export function register(req, res) {
  const { redirect_uris } = req.body || {};
  if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uris required' });
    return;
  }
  const clientId = registerClient(redirect_uris);
  res.status(201).json({
    client_id: clientId,
    redirect_uris,
    token_endpoint_auth_method: 'none',
  });
}

/** GET /oauth/authorize — Show provider selection, then redirect to chosen provider */
export function authorize(req, res) {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type, provider } = req.query;

  if (response_type !== 'code') {
    res.status(400).json({ error: 'unsupported_response_type' });
    return;
  }

  const client = findClient(client_id);
  if (!client) {
    res.status(400).json({ error: 'invalid_client' });
    return;
  }

  const allowedUris = JSON.parse(client.redirect_uris);
  if (!allowedUris.includes(redirect_uri)) {
    res.status(400).json({ error: 'invalid_redirect_uri' });
    return;
  }

  // If provider is specified, redirect directly to that provider
  if (provider && PROVIDERS[provider]) {
    return redirectToProvider(req, res, provider);
  }

  // Show minimal provider selection page
  const qs = new URLSearchParams(req.query);
  res.type('html').send(`<!DOCTYPE html>
<html><head><title>bmail</title>
<style>
  body { font-family: monospace; max-width: 380px; margin: 80px auto; text-align: center; background: #0a0a0a; color: #ccc; }
  h2 { color: #fff; letter-spacing: 2px; }
  a { display: block; padding: 14px; margin: 12px 0; background: #1a1a1a; color: #0f0;
      text-decoration: none; border: 1px solid #333; border-radius: 4px; }
  a:hover { background: #222; border-color: #0f0; }
  p { font-size: 12px; color: #666; }
</style></head>
<body>
  <h2>/// bmail</h2>
  <p>create your agent identity</p>
  <a href="/oauth/authorize?${qs.toString()}&provider=github">GitHub</a>
  <a href="/oauth/authorize?${qs.toString()}&provider=google">Google</a>
  <p style="margin-top: 32px;">bot-to-bot encrypted relay</p>
</body></html>`);
}

function redirectToProvider(req, res, provider) {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method } = req.query;
  const base = process.env.BASE_URL;
  const cfg = PROVIDERS[provider];

  const pendingId = createPendingAuth({
    clientId: client_id,
    redirectUri: redirect_uri,
    state,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method,
    provider,
  });

  const params = new URLSearchParams({
    client_id: provider === 'github' ? process.env.GITHUB_CLIENT_ID : process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${base}/oauth/callback/${provider}`,
    state: pendingId,
    scope: cfg.scopes,
    response_type: 'code',
  });

  res.redirect(`${cfg.authUrl}?${params.toString()}`);
}

/** POST /oauth/token — Exchange auth code for access token */
export function tokenExchange(req, res) {
  const { grant_type, code, code_verifier, redirect_uri } = req.body;

  if (grant_type !== 'authorization_code') {
    res.status(400).json({ error: 'unsupported_grant_type' });
    return;
  }

  const authCode = consumeAuthCode(code);
  if (!authCode) {
    res.status(400).json({ error: 'invalid_grant' });
    return;
  }

  if (authCode.redirect_uri !== redirect_uri) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    return;
  }

  // PKCE verification
  if (authCode.code_challenge) {
    if (!code_verifier) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier required' });
      return;
    }
    const expectedChallenge = crypto.createHash('sha256').update(code_verifier).digest('base64url');
    if (expectedChallenge !== authCode.code_challenge) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      return;
    }
  }

  const accessToken = createAccessToken(authCode.agent_id);
  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    scope: 'bmail',
  });
}
