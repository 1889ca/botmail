/** Contract: OAuth 2.1 authorization server with email magic link identity */

import crypto from 'node:crypto';
import { registerClient, findClient, createPendingAuth, findPendingAuth, deletePendingAuth, consumeAuthCode, createAccessToken, createAuthCode } from '../db.js';
import { sendMagicLink, ensureAgent } from './magic.js';
import { checkMagicLinkRate, recordMagicLink } from '../ratelimit.js';
import { emailFormPage, checkEmailPage, errorPage } from './pages.js';
import { consumeMagicLink } from '../db.js';

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

/** GET /oauth/authorize — Show email input form */
export function authorize(req, res) {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } = req.query;

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

  const pendingId = createPendingAuth({
    clientId: client_id,
    redirectUri: redirect_uri,
    state,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method,
  });

  res.type('html').send(emailFormPage(pendingId));
}

/** POST /oauth/authorize/email — Handle email form submission, send magic link */
export async function submitEmail(req, res) {
  const { email, pending_auth_id } = req.body;

  if (!email || !pending_auth_id) {
    res.status(400).type('html').send(errorPage('Missing email or session.'));
    return;
  }

  const pending = findPendingAuth(pending_auth_id);
  if (!pending) {
    res.status(400).type('html').send(errorPage('Invalid or expired session. Please start over.'));
    return;
  }

  // Always show "check your email" — don't reveal rate limit status (prevents email enumeration)
  const rate = checkMagicLinkRate(email);
  if (rate.allowed) {
    try {
      recordMagicLink(email);
      await sendMagicLink(email, pending_auth_id);
    } catch (err) {
      console.error('Failed to send magic link:', err);
    }
  }

  res.type('html').send(checkEmailPage(email));
}

/** GET /oauth/verify — Handle magic link click */
export function verifyLink(req, res) {
  const { token } = req.query;
  if (!token) {
    res.status(400).type('html').send(errorPage('Missing verification token.'));
    return;
  }

  const link = consumeMagicLink(token);
  if (!link) {
    res.status(400).type('html').send(errorPage('This link is invalid or has expired. Please request a new one.'));
    return;
  }

  const pending = findPendingAuth(link.pending_auth_id);
  if (!pending) {
    res.status(400).type('html').send(errorPage('Auth session expired. Please start over.'));
    return;
  }

  const agent = ensureAgent(link.email);
  finishAuth(res, pending, agent.id);
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

/** Issue auth code and redirect back to the MCP client. */
function finishAuth(res, pending, agentId) {
  const code = createAuthCode({
    clientId: pending.client_id,
    agentId,
    redirectUri: pending.redirect_uri,
    codeChallenge: pending.code_challenge,
    codeChallengeMethod: pending.code_challenge_method,
  });
  deletePendingAuth(pending.id);

  const url = new URL(pending.redirect_uri);
  url.searchParams.set('code', code);
  if (pending.state) url.searchParams.set('state', pending.state);
  res.redirect(url.toString());
}
