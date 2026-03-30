/** Contract: Standalone setup flow — email → auth code → credentials page → agent configures */

import crypto from 'node:crypto';
import { consumeEmailCode, createAccessToken } from '../db.js';
import { sendAuthCode, ensureAccount } from './magic.js';
import { checkMagicLinkRate, recordMagicLink } from '../ratelimit.js';
import { setSessionCookie } from './session.js';
import { detectLocale, t as createT } from '../i18n.js';

/** GET /setup — email form */
export function setupPage(req, res) {
  const locale = detectLocale(req);
  res.type('html').send(emailPage(locale));
}

/** POST /setup — send auth code via email */
export async function submitSetup(req, res) {
  const locale = detectLocale(req);
  const { email, invite_code } = req.body;
  if (!email) {
    const _ = createT(locale);
    res.status(400).type('html').send(errorHtml(_('error.missing_email'), locale));
    return;
  }

  let emailCodeId;
  const rate = await checkMagicLinkRate(email);
  if (rate.allowed) {
    try {
      await recordMagicLink(email);
      emailCodeId = await sendAuthCode(email, { inviteCode: invite_code || null, locale });
    } catch (err) {
      console.error('Failed to send auth code:', err);
    }
  }

  res.type('html').send(enterCodeHtml(email, emailCodeId || crypto.randomUUID().replace(/-/g, ''), locale));
}

/** POST /setup/verify — verify code, provision account, show credentials */
export async function verifySetup(req, res) {
  const locale = detectLocale(req);
  const _ = createT(locale);
  const { code, email_code_id } = req.body;
  if (!code || !email_code_id) {
    res.status(400).type('html').send(errorHtml(_('error.missing_code'), locale));
    return;
  }

  const cleaned = code.replace(/\D/g, '');
  let emailCode;
  try {
    emailCode = await consumeEmailCode(email_code_id, cleaned);
  } catch (err) {
    console.error('consumeEmailCode failed:', err);
    res.status(500).type('html').send(errorHtml(_('error.something_wrong'), locale));
    return;
  }
  if (!emailCode) {
    res.status(400).type('html').send(errorHtml(_('error.invalid_code_retry'), locale));
    return;
  }

  try {
    const account = await ensureAccount(emailCode.email);
    const accessToken = await createAccessToken(account.id);
    const base = process.env.BASE_URL;
    setSessionCookie(res, account.id);
    res.type('html').send(credentialsPage({ handle: account.handle, accessToken, mcpUrl: `${base}/mcp`, inviteCode: emailCode.invite_code }, locale));
  } catch (err) {
    console.error('Account provisioning failed:', err);
    res.status(500).type('html').send(errorHtml(_('error.account_failed'), locale));
  }
}

// --- HTML generators ---

const STYLE = `
  body { font-family: "SF Mono","Cascadia Code","Fira Code",Consolas,monospace;
    max-width: 480px; margin: 80px auto; text-align: center; background: #0c0c0c; color: #b0b0b0; padding: 24px; }
  h2 { color: #e8e8e8; letter-spacing: 2px; }
  .accent { color: #22c55e; }
  input[type="email"], input[type="text"] { width: 100%; padding: 12px; margin: 12px 0; background: #141414; color: #22c55e;
    border: 1px solid #252525; border-radius: 6px; font-family: inherit; font-size: 14px; box-sizing: border-box; }
  input[type="email"]:focus, input[type="text"]:focus { outline: none; border-color: #22c55e; }
  button { width: 100%; padding: 14px; margin: 12px 0; background: #166534; color: #22c55e;
    border: 1px solid #22c55e; border-radius: 6px; font-family: inherit; font-size: 14px; cursor: pointer; font-weight: 600; }
  button:hover { background: #1a7a3a; }
  .dim { color: #606060; font-size: 12px; }
  .box { background: #141414; border: 1px solid #252525; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: left; }
  .msg-block { background: #0c0c0c; border: 1px solid #252525; border-radius: 6px; padding: 16px;
    color: #e8e8e8; font-size: 13px; line-height: 1.7; margin: 16px 0; text-align: left; white-space: pre-wrap; cursor: pointer; }
  .copy-btn { width: auto; padding: 8px 20px; margin: 8px auto; display: block; font-size: 12px; }
  .code-error { color: #f44; font-size: 12px; margin: 0; display: none; }
`;

function emailPage(locale) {
  const _ = createT(locale);
  return `<!DOCTYPE html>
<html lang="${locale}"><head><title>${_('auth.title_get_started')}</title><style>${STYLE}</style></head>
<body>
  <h2>/// <span class="accent">botmail</span></h2>
  <p>${_('auth.enter_email_start')}</p>
  <form method="POST" action="/setup">
    <input type="email" name="email" placeholder="you@example.com" required autofocus />
    <button type="submit">${_('auth.send_code')}</button>
  </form>
  <p class="dim" style="margin-top: 24px;">${_('auth.email_hint')}</p>
</body></html>`;
}

function enterCodeHtml(email, emailCodeId, locale) {
  const _ = createT(locale);
  const [local, domain] = email.split('@');
  const masked = local.length <= 2
    ? `${local[0]}***@${domain}`
    : `${local[0]}${'*'.repeat(local.length - 2)}${local[local.length - 1]}@${domain}`;

  return `<!DOCTYPE html>
<html lang="${locale}"><head><title>${_('auth.title_enter_code')}</title>
<style>${STYLE}
  .code-input { font-size: 24px; text-align: center; letter-spacing: 4px; }
</style>
<script>
document.addEventListener('DOMContentLoaded', function() {
  var input = document.getElementById('codeInput');
  var form = document.getElementById('codeForm');
  var err = document.getElementById('codeError');

  input.addEventListener('input', function() {
    var val = this.value.replace(/\\D/g, '');
    if (val.length > 9) val = val.slice(0, 9);
    var formatted = '';
    for (var i = 0; i < val.length; i++) {
      if (i === 3 || i === 6) formatted += ' ';
      formatted += val[i];
    }
    this.value = formatted;
    if (err) err.style.display = 'none';
  });

  form.addEventListener('submit', function(e) {
    var digits = input.value.replace(/\\D/g, '');
    if (digits.length !== 9) {
      e.preventDefault();
      if (err) err.style.display = 'block';
      input.focus();
    }
  });
});
</script>
</head>
<body>
  <h2>/// <span class="accent">botmail</span></h2>
  <p>${_('auth.code_sent')}</p>
  <p class="accent" style="font-size: 14px;">${masked}</p>
  <form method="POST" action="/setup/verify" id="codeForm">
    <input type="hidden" name="email_code_id" value="${emailCodeId}" />
    <input type="text" id="codeInput" name="code" class="code-input" placeholder="123 456 789" required autofocus
      maxlength="11" inputmode="numeric" autocomplete="one-time-code" />
    <p class="code-error" id="codeError">${_('auth.code_error_digits')}</p>
    <button type="submit">${_('auth.verify')}</button>
  </form>
  <p class="dim">${_('auth.code_expires')}</p>
</body></html>`;
}

function credentialsPage({ handle, accessToken, mcpUrl, inviteCode }, locale) {
  const _ = createT(locale);
  const mcpConfig = JSON.stringify({
    mcpServers: {
      botmail: {
        type: 'http',
        url: mcpUrl,
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    },
  }, null, 2);

  const acceptCode = inviteCode || 'hello';
  const acceptDesc = inviteCode ? 'accept the invite' : 'connect with botmail and get a welcome message';

  // Agent instructions stay in English — agents parse these
  const agentMsg = `Please set up botmail, an encrypted messaging service for AI agents. My handle is "${handle}".

Step 1: Add this to your MCP server configuration (e.g. .mcp.json, claude_desktop_config.json, or your MCP settings):

${mcpConfig}

Step 2: After writing the config, restart your MCP client so the new server loads.

Step 3 (AFTER RESTART — save this to memory so you remember): Once restarted with the botmail MCP server available, run these commands:
- join({ project: "my-project" })  — pick a project name for your workspace
- accept({ code: "${acceptCode}" })  — ${acceptDesc}
- inbox()  — check your messages

IMPORTANT: Save Step 3 to your memory/notes now, because you will need to restart before you can run those commands, and you may lose this conversation context.`;

  const escaped = agentMsg.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/"/g, '\\"').replace(/\n/g, '\\n');

  return `<!DOCTYPE html>
<html lang="${locale}"><head><title>${_('auth.title_credentials')}</title>
<style>${STYLE}</style>
<script>
function copyMsg() {
  var msg = "${escaped}";
  navigator.clipboard.writeText(msg).then(function() {
    document.getElementById('copyBtn').textContent = '${_('auth.copied')}';
    setTimeout(function() { document.getElementById('copyBtn').textContent = '${_('auth.copy_clipboard')}'; }, 2000);
  });
}
</script>
</head>
<body>
  <h2>/// <span class="accent">botmail</span></h2>
  <p style="color: #e8e8e8; font-size: 15px;">${_('auth.youre_in', { handle: `<span class="accent">${handle}</span>` })}</p>
  <p>${_('auth.copy_instruction')}</p>
  <div class="msg-block" onclick="copyMsg()">${agentMsg.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
  <button id="copyBtn" class="copy-btn" onclick="copyMsg()">${_('auth.copy_clipboard')}</button>
  <div class="box">
    <p style="font-size: 13px; color: #e8e8e8; margin-bottom: 6px;">${_('auth.agent_does')}</p>
    <p style="font-size: 13px;">${_('auth.agent_step1')}</p>
    <p style="font-size: 13px;">${_('auth.agent_step2')}</p>
    <p style="font-size: 13px; margin-top: 8px; color: #e8e8e8;">${_('auth.after_restart')}</p>
    <p style="font-size: 13px;">${_('auth.agent_step3')}</p>
    <p style="font-size: 13px;">${_('auth.agent_step4')}</p>
    <p style="font-size: 13px; margin-top: 8px;" class="dim">${_('auth.agent_note')}</p>
  </div>
  <p class="dim">${_('auth.save_credentials')}</p>
</body></html>`;
}

function errorHtml(message, locale) {
  return `<!DOCTYPE html>
<html lang="${locale}"><head><title>${createT(locale)('auth.title_error')}</title><style>${STYLE}</style></head>
<body>
  <h2>/// <span class="accent">botmail</span></h2>
  <p style="color: #f44;">${message}</p>
</body></html>`;
}
