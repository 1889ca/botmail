/** Contract: OAuth 2.1 authorization server with email magic link identity */

import crypto from 'node:crypto';
import { registerClient, findClient, createPendingAuth, findPendingAuth, deletePendingAuth, consumeAuthCode, createAccessToken, createAuthCode, consumeMagicLink } from '../db.js';
import { sendMagicLink, ensureAccount } from './magic.js';
import { checkMagicLinkRate, recordMagicLink } from '../ratelimit.js';
import { emailFormPage, checkEmailPage, errorPage } from './pages.js';
import { setSessionCookie, getSessionAccount } from './session.js';

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
export async function register(req, res) {
  const { redirect_uris } = req.body || {};
  if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uris required' });
    return;
  }
  const clientId = await registerClient(redirect_uris);
  res.status(201).json({
    client_id: clientId,
    redirect_uris,
    token_endpoint_auth_method: 'none',
  });
}

/** GET /oauth/authorize — Show email input form */
export async function authorize(req, res) {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } = req.query;

  if (response_type !== 'code') {
    res.status(400).json({ error: 'unsupported_response_type' });
    return;
  }

  const client = await findClient(client_id);
  if (!client) {
    res.status(400).json({ error: 'invalid_client' });
    return;
  }

  const allowedUris = JSON.parse(client.redirect_uris);
  if (!allowedUris.includes(redirect_uri)) {
    res.status(400).json({ error: 'invalid_redirect_uri' });
    return;
  }

  const pending = {
    clientId: client_id,
    redirectUri: redirect_uri,
    state,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method,
  };

  // Auto-approve if browser has a valid session cookie
  const account = await getSessionAccount(req);
  if (account) {
    const pendingId = await createPendingAuth(pending);
    const pendingRow = await findPendingAuth(pendingId);
    return finishAuth(res, pendingRow, account.id);
  }

  const pendingId = await createPendingAuth(pending);
  res.type('html').send(emailFormPage(pendingId));
}

/** POST /oauth/authorize/email — Handle email form submission, send magic link */
export async function submitEmail(req, res) {
  const { email, pending_auth_id } = req.body;

  if (!email || !pending_auth_id) {
    res.status(400).type('html').send(errorPage('Missing email or session.'));
    return;
  }

  const pending = await findPendingAuth(pending_auth_id);
  if (!pending) {
    res.status(400).type('html').send(errorPage('Invalid or expired session. Please start over.'));
    return;
  }

  // Always show "check your email" — don't reveal rate limit status (prevents email enumeration)
  const rate = await checkMagicLinkRate(email);
  if (rate.allowed) {
    try {
      await recordMagicLink(email);
      await sendMagicLink(email, pending_auth_id);
    } catch (err) {
      console.error('Failed to send magic link:', err);
    }
  }

  res.type('html').send(checkEmailPage(email));
}

/** GET /oauth/verify — Handle magic link click */
export async function verifyLink(req, res) {
  const { token } = req.query;
  if (!token) {
    res.status(400).type('html').send(errorPage('Missing verification token.'));
    return;
  }

  const link = await consumeMagicLink(token);
  if (!link) {
    res.status(400).type('html').send(errorPage('This link is invalid or has expired. Please request a new one.'));
    return;
  }

  const pending = await findPendingAuth(link.pending_auth_id);
  if (!pending) {
    res.status(400).type('html').send(errorPage('Auth session expired. Please start over.'));
    return;
  }

  const account = await ensureAccount(link.email);
  setSessionCookie(res, account.id);
  await finishAuth(res, pending, account.id);
}

/** POST /oauth/token — Exchange auth code for access token */
export async function tokenExchange(req, res) {
  const { grant_type, code, code_verifier, redirect_uri } = req.body;

  if (grant_type !== 'authorization_code') {
    res.status(400).json({ error: 'unsupported_grant_type' });
    return;
  }

  const authCode = await consumeAuthCode(code);
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

  const accessToken = await createAccessToken(authCode.account_id);
  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    scope: 'botmail',
  });
}

/** Issue auth code and redirect back to the MCP client. */
async function finishAuth(res, pending, accountId) {
  const code = await createAuthCode({
    clientId: pending.client_id,
    accountId,
    redirectUri: pending.redirect_uri,
    codeChallenge: pending.code_challenge,
    codeChallengeMethod: pending.code_challenge_method,
  });
  await deletePendingAuth(pending.id);

  const url = new URL(pending.redirect_uri);
  url.searchParams.set('code', code);
  if (pending.state) url.searchParams.set('state', pending.state);
  res.redirect(url.toString());
}
