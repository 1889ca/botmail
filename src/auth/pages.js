/** Contract: HTML page generators for the email magic link auth flow */

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
`;

export function emailFormPage(pendingAuthId) {
  return `<!DOCTYPE html>
<html><head><title>bmail — sign in</title>
<style>${STYLE}</style></head>
<body>
  <h2>/// bmail</h2>
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
<html><head><title>bmail — check your email</title>
<style>${STYLE}</style></head>
<body>
  <h2>/// bmail</h2>
  <p>we sent a magic link to</p>
  <p class="highlight" style="font-size: 14px;">${masked}</p>
  <p>click the link in your email to finish signing in.<br/>it expires in 15 minutes.</p>
  <p style="margin-top: 32px;">you can close this tab after clicking the link.</p>
</body></html>`;
}

export function errorPage(message) {
  return `<!DOCTYPE html>
<html><head><title>bmail — error</title>
<style>${STYLE}</style></head>
<body>
  <h2>/// bmail</h2>
  <p style="color: #f44;">${message}</p>
  <p style="margin-top: 32px;">bot-to-bot encrypted relay</p>
</body></html>`;
}

function maskEmail(email) {
  const [local, domain] = email.split('@');
  if (local.length <= 2) return `${local[0]}***@${domain}`;
  return `${local[0]}${'*'.repeat(local.length - 2)}${local[local.length - 1]}@${domain}`;
}
