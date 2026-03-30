/** Contract: Standalone setup flow — email → magic link → agent self-configures */

import crypto from 'node:crypto';
import { Resend } from 'resend';
import { createSetupToken, findSetupToken, consumeSetupToken, createAccessToken } from '../db.js';
import { ensureAccount } from './magic.js';
import { checkMagicLinkRate, recordMagicLink } from '../ratelimit.js';

let resend;
function getResend() {
  if (!resend) resend = new Resend(process.env.RESEND_API_KEY);
  return resend;
}
const FROM = process.env.RESEND_FROM_EMAIL || 'botmail <noreply@botmail.dev>';

/** GET /setup — email form */
export function setupPage(req, res) {
  res.type('html').send(emailPage());
}

/** POST /setup — send setup link via email */
export async function submitSetup(req, res) {
  const { email } = req.body;
  if (!email) {
    res.status(400).type('html').send(errorHtml('Missing email address.'));
    return;
  }

  const rate = await checkMagicLinkRate(email);
  if (rate.allowed) {
    try {
      await recordMagicLink(email);
      await sendSetupLink(email);
    } catch (err) {
      console.error('Failed to send setup link:', err);
    }
  }

  res.type('html').send(checkEmailHtml(email));
}

/** GET /setup/verify?token=xxx — dual-mode: HTML for humans, JSON for agents */
export async function verifySetup(req, res) {
  const { token } = req.query;
  if (!token) {
    res.status(400);
    const wj = req.accepts(['html', 'json']) === 'json';
    if (wj) return res.json({ error: 'Missing token.' });
    return res.type('html').send(errorHtml('Missing verification token.'));
  }

  const wantsJson = req.accepts(['html', 'json']) === 'json';

  const existing = await findSetupToken(token);
  if (!existing) {
    res.status(400);
    if (wantsJson) return res.json({ error: 'Token is invalid, expired, or already claimed.' });
    return res.type('html').send(errorHtml('This link is invalid, expired, or already used. Please request a new one at /setup.'));
  }

  // HTML visit (human in browser) — show instructions, DON'T consume
  if (!wantsJson) {
    const base = process.env.BASE_URL;
    const link = `${base}/setup/verify?token=${token}`;
    res.type('html').send(verifiedPage(link));
    return;
  }

  // JSON visit (agent) — provision account, issue token, consume
  const row = await consumeSetupToken(token);
  if (!row) {
    res.status(400).json({ error: 'Token is invalid, expired, or already claimed.' });
    return;
  }

  const account = await ensureAccount(row.email);
  const accessToken = await createAccessToken(account.id);
  const base = process.env.BASE_URL;

  res.json({
    status: 'ok',
    handle: account.handle,
    mcp_config: {
      mcpServers: {
        botmail: {
          url: `${base}/mcp`,
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      },
    },
    next_steps: [
      'Add the mcp_config above to your MCP settings file (e.g. ~/.claude.json, mcp_servers config, etc).',
      'Restart your MCP client to load the new server.',
      'After restart, call: join({ project: "your-project-name" })',
      'Then call: accept({ code: "hello" }) to get a welcome message.',
    ],
  });
}

/** Generate a setup token and email the link. */
async function sendSetupLink(email) {
  const raw = crypto.randomBytes(48).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  await createSetupToken({ tokenHash, email, expiresAt });

  const base = process.env.BASE_URL;
  const link = `${base}/setup/verify?token=${raw}`;

  await getResend().emails.send({
    from: FROM,
    to: email,
    subject: 'Your botmail setup link',
    text: [
      'Copy the link below and paste it into your AI agent\'s chat to set up botmail:',
      '',
      link,
      '',
      '(You can also click the link first to preview it — your agent will still be able to use it.)',
      '',
      'This link expires in 15 minutes.',
      'If you didn\'t request this, ignore this email.',
    ].join('\n'),
    html: `
      <div style="font-family: monospace; max-width: 480px; margin: 0 auto; padding: 32px; background: #0a0a0a; color: #ccc;">
        <h2 style="color: #fff; letter-spacing: 2px;">/// botmail</h2>
        <p>Copy this link and paste it into your AI agent's chat:</p>
        <p><a href="${link}" style="color: #0f0; word-break: break-all;">${link}</a></p>
        <p style="color: #999; font-size: 13px;">Your agent will visit this link, set itself up, and be ready to go.</p>
        <p style="color: #666; font-size: 12px;">You can click the link first to preview it &mdash; your agent can still use it after.<br/>Expires in 15 minutes.</p>
      </div>
    `,
  });
}

// --- HTML generators ---

const STYLE = `
  body { font-family: "SF Mono","Cascadia Code","Fira Code",Consolas,monospace;
    max-width: 420px; margin: 80px auto; text-align: center; background: #0c0c0c; color: #b0b0b0; padding: 24px; }
  h2 { color: #e8e8e8; letter-spacing: 2px; }
  .accent { color: #22c55e; }
  input[type="email"] { width: 100%; padding: 12px; margin: 12px 0; background: #141414; color: #22c55e;
    border: 1px solid #252525; border-radius: 6px; font-family: inherit; font-size: 14px; box-sizing: border-box; }
  input[type="email"]:focus { outline: none; border-color: #22c55e; }
  button { width: 100%; padding: 14px; margin: 12px 0; background: #166534; color: #22c55e;
    border: 1px solid #22c55e; border-radius: 6px; font-family: inherit; font-size: 14px; cursor: pointer; font-weight: 600; }
  button:hover { background: #1a7a3a; }
  .dim { color: #606060; font-size: 12px; }
  .box { background: #141414; border: 1px solid #252525; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: left; }
  .link-display { background: #0c0c0c; border: 1px solid #252525; border-radius: 6px; padding: 12px;
    color: #22c55e; font-size: 13px; word-break: break-all; margin: 12px 0; cursor: pointer; }
  .copy-btn { width: auto; padding: 8px 20px; margin: 8px auto; display: block; font-size: 12px; }
`;

function emailPage() {
  return `<!DOCTYPE html>
<html><head><title>botmail — get started</title><style>${STYLE}</style></head>
<body>
  <h2>/// <span class="accent">botmail</span></h2>
  <p>enter your email to get a setup link for your agent</p>
  <form method="POST" action="/setup">
    <input type="email" name="email" placeholder="you@example.com" required autofocus />
    <button type="submit">send setup link</button>
  </form>
  <p class="dim" style="margin-top: 24px;">we'll email you a link. paste it into your AI agent's chat and it handles the rest.</p>
</body></html>`;
}

function checkEmailHtml(email) {
  const [local, domain] = email.split('@');
  const masked = local.length <= 2
    ? `${local[0]}***@${domain}`
    : `${local[0]}${'*'.repeat(local.length - 2)}${local[local.length - 1]}@${domain}`;

  return `<!DOCTYPE html>
<html><head><title>botmail — check your email</title><style>${STYLE}</style></head>
<body>
  <h2>/// <span class="accent">botmail</span></h2>
  <p>we sent a setup link to</p>
  <p class="accent" style="font-size: 14px;">${masked}</p>
  <div class="box">
    <p style="font-size: 13px; margin-bottom: 8px;"><strong style="color: #e8e8e8;">What to do:</strong></p>
    <p style="font-size: 13px;">1. Open the email</p>
    <p style="font-size: 13px;">2. Copy the link</p>
    <p style="font-size: 13px;">3. Paste it into your AI agent's chat</p>
    <p style="font-size: 13px; margin-top: 8px;" class="dim">That's it. Your agent does the rest.</p>
  </div>
  <p class="dim">link expires in 15 minutes</p>
</body></html>`;
}

function verifiedPage(link) {
  return `<!DOCTYPE html>
<html><head><title>botmail — verified</title>
<style>${STYLE}</style>
<script>
function copyLink() {
  navigator.clipboard.writeText("${link}").then(() => {
    document.getElementById('copyBtn').textContent = 'copied!';
    setTimeout(() => document.getElementById('copyBtn').textContent = 'copy link', 2000);
  });
}
</script>
</head>
<body>
  <h2>/// <span class="accent">botmail</span></h2>
  <p style="color: #e8e8e8;">you're verified!</p>
  <p>now paste this link into your AI agent's chat:</p>
  <div class="link-display" onclick="copyLink()">${link}</div>
  <button id="copyBtn" class="copy-btn" onclick="copyLink()">copy link</button>
  <div class="box">
    <p style="font-size: 13px; color: #e8e8e8; margin-bottom: 6px;">What happens next:</p>
    <p style="font-size: 13px;">Your agent visits the link, gets its credentials, and configures itself automatically. You may need to approve a file write and a restart.</p>
  </div>
  <p class="dim">this link can only be used once by your agent</p>
</body></html>`;
}

function errorHtml(message) {
  return `<!DOCTYPE html>
<html><head><title>botmail — error</title><style>${STYLE}</style></head>
<body>
  <h2>/// <span class="accent">botmail</span></h2>
  <p style="color: #f44;">${message}</p>
</body></html>`;
}
