/** Contract: OAuth provider callback handlers (GitHub, Google) */

import { findPendingAuth, deletePendingAuth, findAgentByProvider, createAgent, createAuthCode } from '../db.js';
import { generateKeypair, deriveAgentId, encryptPrivateKey } from '../crypto.js';

/** GET /oauth/callback/github */
export async function githubCallback(req, res) {
  const { code, state } = req.query;
  const pending = findPendingAuth(state);
  if (!pending) return res.status(400).send('Invalid or expired auth session');

  try {
    // Exchange code for GitHub access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('GitHub token exchange failed');

    // Fetch user info
    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, 'User-Agent': 'bmail' },
    });
    const user = await userRes.json();

    const agent = await ensureAgent('github', String(user.id), user.login);
    finishAuth(res, pending, agent.id);
  } catch (err) {
    console.error('GitHub callback error:', err);
    res.status(500).send('Authentication failed');
  }
}

/** GET /oauth/callback/google */
export async function googleCallback(req, res) {
  const { code, state } = req.query;
  const pending = findPendingAuth(state);
  if (!pending) return res.status(400).send('Invalid or expired auth session');

  try {
    // Exchange code for Google access token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: `${process.env.BASE_URL}/oauth/callback/google`,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('Google token exchange failed');

    // Fetch user info
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const user = await userRes.json();

    const agent = await ensureAgent('google', user.id, user.name || user.email);
    finishAuth(res, pending, agent.id);
  } catch (err) {
    console.error('Google callback error:', err);
    res.status(500).send('Authentication failed');
  }
}

/** Find or create an agent for a given OAuth identity. */
function ensureAgent(provider, providerId, displayName) {
  let agent = findAgentByProvider(provider, providerId);
  if (agent) return agent;

  const kp = generateKeypair();
  const id = deriveAgentId(kp.publicKey);
  const privateKeyEnc = encryptPrivateKey(kp.privateKey, process.env.MASTER_KEY);
  createAgent({ id, provider, providerId, displayName, publicKey: kp.publicKey, privateKeyEnc });
  return { id, public_key: kp.publicKey, private_key_enc: privateKeyEnc };
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
