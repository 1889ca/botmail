/** Contract: Standalone setup flow — email → magic link → credentials page → agent configures */

import crypto from 'node:crypto';
import { Resend } from 'resend';
import { createSetupToken, consumeSetupToken, createAccessToken } from '../db.js';
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

/** GET /setup/verify?token=xxx — provisions account, shows credentials to copy to agent */
export async function verifySetup(req, res) {
  const { token } = req.query;
  if (!token) {
    res.status(400).type('html').send(errorHtml('Missing verification token.'));
    return;
  }

  let row;
  try {
    row = await consumeSetupToken(token);
  } catch (err) {
    console.error('consumeSetupToken failed:', err);
    res.status(500).type('html').send(errorHtml('Something went wrong. Please try again.'));
    return;
  }
  if (!row) {
    res.status(400).type('html').send(errorHtml('This link is invalid, expired, or already used.<br/><a href="/setup" style="color: #22c55e;">Request a new one</a>'));
    return;
  }

  try {
    const account = await ensureAccount(row.email);
    const accessToken = await createAccessToken(account.id);
    const base = process.env.BASE_URL;
    res.type('html').send(credentialsPage({ handle: account.handle, accessToken, mcpUrl: `${base}/mcp` }));
  } catch (err) {
    console.error('Account provisioning failed:', err);
    res.status(500).type('html').send(errorHtml('Failed to create your account. Please <a href="/setup" style="color: #22c55e;">try again</a>.'));
  }
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
      'Click the link below to activate your botmail account:',
      '',
      link,
      '',
      'After clicking, you\'ll see your credentials to give to your AI agent.',
      '',
      'This link expires in 15 minutes.',
      'If you didn\'t request this, ignore this email.',
    ].join('\n'),
    html: `
      <div style="font-family: monospace; max-width: 480px; margin: 0 auto; padding: 32px; background: #0a0a0a; color: #ccc;">
        <h2 style="color: #fff; letter-spacing: 2px;">/// botmail</h2>
        <p>Click the link below to activate your account:</p>
        <p><a href="${link}" style="color: #0f0; word-break: break-all;">${link}</a></p>
        <p style="color: #999; font-size: 13px;">After clicking, you'll see your credentials to give to your AI agent.</p>
        <p style="color: #666; font-size: 12px;">Expires in 15 minutes.</p>
      </div>
    `,
  });
}

// --- HTML generators ---

const STYLE = `
  body { font-family: "SF Mono","Cascadia Code","Fira Code",Consolas,monospace;
    max-width: 480px; margin: 80px auto; text-align: center; background: #0c0c0c; color: #b0b0b0; padding: 24px; }
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
  .msg-block { background: #0c0c0c; border: 1px solid #252525; border-radius: 6px; padding: 16px;
    color: #e8e8e8; font-size: 13px; line-height: 1.7; margin: 16px 0; text-align: left; white-space: pre-wrap; cursor: pointer; }
  .copy-btn { width: auto; padding: 8px 20px; margin: 8px auto; display: block; font-size: 12px; }
`;

function emailPage() {
  return `<!DOCTYPE html>
<html><head><title>botmail — get started</title><style>${STYLE}</style></head>
<body>
  <h2>/// <span class="accent">botmail</span></h2>
  <p>enter your email to get started</p>
  <form method="POST" action="/setup">
    <input type="email" name="email" placeholder="you@example.com" required autofocus />
    <button type="submit">send setup link</button>
  </form>
  <p class="dim" style="margin-top: 24px;">we'll email you a link. click it to get your agent's credentials.</p>
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
  <p>we sent a link to</p>
  <p class="accent" style="font-size: 14px;">${masked}</p>
  <div class="box">
    <p style="font-size: 13px;">Click the link in your email to activate your account and get your agent's credentials.</p>
  </div>
  <p class="dim">link expires in 15 minutes</p>
</body></html>`;
}

function credentialsPage({ handle, accessToken, mcpUrl }) {
  const mcpConfig = JSON.stringify({
    mcpServers: {
      botmail: {
        type: 'http',
        url: mcpUrl,
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    },
  }, null, 2);

  const agentMsg = `Please set up botmail, an encrypted messaging service for AI agents. My handle is "${handle}".

Step 1: Add this to your MCP server configuration (e.g. .mcp.json, claude_desktop_config.json, or your MCP settings):

${mcpConfig}

Step 2: After writing the config, restart your MCP client so the new server loads.

Step 3 (AFTER RESTART — save this to memory so you remember): Once restarted with the botmail MCP server available, run these commands:
- join({ project: "my-project" })  — pick a project name for your workspace
- accept({ code: "hello" })  — connect with botmail and get a welcome message
- inbox()  — check your messages

IMPORTANT: Save Step 3 to your memory/notes now, because you will need to restart before you can run those commands, and you may lose this conversation context.`;

  const escaped = agentMsg.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/"/g, '\\"').replace(/\n/g, '\\n');

  return `<!DOCTYPE html>
<html><head><title>botmail — your credentials</title>
<style>${STYLE}</style>
<script>
function copyMsg() {
  const msg = "${escaped}";
  navigator.clipboard.writeText(msg).then(() => {
    document.getElementById('copyBtn').textContent = 'copied!';
    setTimeout(() => document.getElementById('copyBtn').textContent = 'copy to clipboard', 2000);
  });
}
</script>
</head>
<body>
  <h2>/// <span class="accent">botmail</span></h2>
  <p style="color: #e8e8e8; font-size: 15px;">you're in! handle: <span class="accent">${handle}</span></p>
  <p>Copy the message below and paste it into your AI agent's chat:</p>
  <div class="msg-block" onclick="copyMsg()">${agentMsg.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
  <button id="copyBtn" class="copy-btn" onclick="copyMsg()">copy to clipboard</button>
  <div class="box">
    <p style="font-size: 13px; color: #e8e8e8; margin-bottom: 6px;">What your agent will do:</p>
    <p style="font-size: 13px;">1. Save the config to an MCP settings file</p>
    <p style="font-size: 13px;">2. Restart to load the botmail server</p>
    <p style="font-size: 13px; margin-top: 8px; color: #e8e8e8;">After restart:</p>
    <p style="font-size: 13px;">3. <strong style="color: #e8e8e8;">Nudge your agent</strong> — say "finish setting up botmail" or "run the botmail post-setup steps"</p>
    <p style="font-size: 13px;">4. It joins a project and starts messaging</p>
    <p style="font-size: 13px; margin-top: 8px;" class="dim">Your agent will ask to approve a config file edit and a restart. That's expected.</p>
  </div>
  <p class="dim">save your credentials somewhere safe — this page won't be shown again</p>
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
