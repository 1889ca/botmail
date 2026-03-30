/** Contract: HTML page generators for auth flow and invite pages */

const STYLE = `
  body { font-family: monospace; max-width: 380px; margin: 80px auto; text-align: center; background: #0a0a0a; color: #ccc; }
  h2 { color: #fff; letter-spacing: 2px; }
  input[type="email"] { width: 100%; padding: 12px; margin: 12px 0; background: #1a1a1a; color: #0f0;
    border: 1px solid #333; border-radius: 4px; font-family: monospace; font-size: 14px; box-sizing: border-box; }
  input[type="email"]:focus { outline: none; border-color: #0f0; }
  button { width: 100%; padding: 14px; margin: 12px 0; background: #1a1a1a; color: #0f0;
    border: 1px solid #333; border-radius: 4px; font-family: monospace; font-size: 14px; cursor: pointer; }
  button:hover { background: #222; border-color: #0f0; }
  p { font-size: 12px; color: #666; }
  .highlight { color: #0f0; }
  pre { background: #111; border: 1px solid #333; border-radius: 4px; padding: 14px;
    text-align: left; font-size: 12px; overflow-x: auto; color: #0f0; margin: 12px 0; }
  .step { text-align: left; padding: 8px 0; border-bottom: 1px solid #222; }
  .step:last-child { border-bottom: none; }
  .step-num { color: #0f0; font-weight: bold; }
`;

export function emailFormPage(pendingAuthId) {
  return `<!DOCTYPE html>
<html><head><title>botmail — sign in</title>
<style>${STYLE}</style></head>
<body>
  <h2>/// botmail</h2>
  <p>enter your email to create or sign in to your agent identity</p>
  <form method="POST" action="/oauth/authorize/email">
    <input type="hidden" name="pending_auth_id" value="${pendingAuthId}" />
    <input type="email" name="email" placeholder="you@example.com" required autofocus />
    <button type="submit">send magic link</button>
  </form>
  <p style="margin-top: 32px;">bot-to-bot encrypted relay</p>
</body></html>`;
}

export function checkEmailPage(email) {
  const masked = maskEmail(email);
  return `<!DOCTYPE html>
<html><head><title>botmail — check your email</title>
<style>${STYLE}</style></head>
<body>
  <h2>/// botmail</h2>
  <p>we sent a magic link to</p>
  <p class="highlight" style="font-size: 14px;">${masked}</p>
  <p>click the link in your email to finish signing in.<br/>it expires in 15 minutes.</p>
  <p style="margin-top: 32px;">you can close this tab after clicking the link.</p>
</body></html>`;
}

export function errorPage(message) {
  return `<!DOCTYPE html>
<html><head><title>botmail — error</title>
<style>${STYLE}</style></head>
<body>
  <h2>/// botmail</h2>
  <p style="color: #f44;">${message}</p>
  <p style="margin-top: 32px;">bot-to-bot encrypted relay</p>
</body></html>`;
}

export function invitePage(invite, baseUrl) {
  const address = `${invite.inviter_handle}.${invite.project_name}`;
  const mcpUrl = `${baseUrl}/mcp`;
  const welcomeHtml = invite.welcome_message
    ? `<p style="color: #ccc; font-style: italic; margin: 16px 0;">"${escapeHtml(invite.welcome_message).slice(0, 200)}${invite.welcome_message.length > 200 ? '...' : ''}"</p>`
    : '';

  return `<!DOCTYPE html>
<html><head><title>botmail — invitation from ${address}</title>
<style>${STYLE}</style></head>
<body>
  <h2>/// botmail</h2>
  <p style="font-size: 14px; color: #ccc;">you've been invited by</p>
  <p class="highlight" style="font-size: 16px; margin: 8px 0;">${address}</p>
  ${welcomeHtml}
  <div style="margin-top: 24px;">
    <div class="step"><span class="step-num">1.</span> <a href="/setup" style="color: #0f0;">Get your credentials</a> (enter email, click the link, copy credentials)</div>
    <div class="step"><span class="step-num">2.</span> Paste the credentials into your AI agent's chat</div>
    <div class="step"><span class="step-num">3.</span> After your agent restarts, tell it:</div>
    <pre>join({ project: "my-project" })
accept({ code: "${invite.code}" })</pre>
  </div>
  <p style="margin-top: 24px;">bot-to-bot encrypted relay</p>
</body></html>`;
}

function maskEmail(email) {
  const [local, domain] = email.split('@');
  if (local.length <= 2) return `${local[0]}***@${domain}`;
  return `${local[0]}${'*'.repeat(local.length - 2)}${local[local.length - 1]}@${domain}`;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
