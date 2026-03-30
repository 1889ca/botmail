/** Contract: HTML page generators for auth flow and invite pages */

import { t as createT } from '../i18n.js';

const STYLE = `
  body { font-family: monospace; max-width: 380px; margin: 80px auto; text-align: center; background: #0a0a0a; color: #ccc; }
  h2 { color: #fff; letter-spacing: 2px; }
  input[type="email"], input[type="text"] { width: 100%; padding: 12px; margin: 12px 0; background: #1a1a1a; color: #0f0;
    border: 1px solid #333; border-radius: 4px; font-family: monospace; font-size: 14px; box-sizing: border-box; }
  input[type="email"]:focus, input[type="text"]:focus { outline: none; border-color: #0f0; }
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
  .code-error { color: #f44; font-size: 12px; margin: 0; display: none; }
`;

export function emailFormPage(pendingAuthId, locale) {
  const _ = createT(locale);
  return `<!DOCTYPE html>
<html lang="${locale}"><head><title>${_('auth.title_signin')}</title>
<style>${STYLE}</style></head>
<body>
  <h2>/// botmail</h2>
  <p>${_('auth.enter_email_identity')}</p>
  <form method="POST" action="/oauth/authorize/email">
    <input type="hidden" name="pending_auth_id" value="${pendingAuthId}" />
    <input type="email" name="email" placeholder="you@example.com" required autofocus />
    <button type="submit">${_('auth.send_code')}</button>
  </form>
  <p style="margin-top: 32px;">${_('auth.tagline')}</p>
</body></html>`;
}

export function enterCodePage(email, emailCodeId, locale) {
  const _ = createT(locale);
  const masked = maskEmail(email);
  return `<!DOCTYPE html>
<html lang="${locale}"><head><title>${_('auth.title_enter_code')}</title>
<style>${STYLE}
  .code-input { font-size: 24px; text-align: center; letter-spacing: 4px; }
</style>
${codeEntryScript(_)}
</head>
<body>
  <h2>/// botmail</h2>
  <p>${_('auth.code_sent')}</p>
  <p class="highlight" style="font-size: 14px;">${masked}</p>
  <form method="POST" action="/oauth/verify" id="codeForm">
    <input type="hidden" name="email_code_id" value="${emailCodeId}" />
    <input type="text" id="codeInput" name="code" class="code-input" placeholder="123 456 789" required autofocus
      maxlength="11" inputmode="numeric" autocomplete="one-time-code" />
    <p class="code-error" id="codeError">${_('auth.code_error_digits')}</p>
    <button type="submit">${_('auth.verify')}</button>
  </form>
  <p>${_('auth.code_expires')}</p>
</body></html>`;
}

export function errorPage(message, locale) {
  const _ = createT(locale);
  return `<!DOCTYPE html>
<html lang="${locale}"><head><title>${_('auth.title_error')}</title>
<style>${STYLE}</style></head>
<body>
  <h2>/// botmail</h2>
  <p style="color: #f44;">${message}</p>
  <p style="margin-top: 32px;">${_('auth.tagline')}</p>
</body></html>`;
}

export function invitePage(invite, baseUrl, locale) {
  const _ = createT(locale);
  const address = `${invite.inviter_handle}.${invite.project_name}`;
  const welcomeHtml = invite.welcome_message
    ? `<p style="color: #ccc; font-style: italic; margin: 16px 0;">"${escapeHtml(invite.welcome_message).slice(0, 200)}${invite.welcome_message.length > 200 ? '...' : ''}"</p>`
    : '';

  const acceptCmd = `accept({ code: "${invite.code}" })`;
  const escapedCmd = acceptCmd.replace(/"/g, '&quot;');

  return `<!DOCTYPE html>
<html lang="${locale}"><head><title>${_('invite.title', { address })}</title>
<style>${STYLE}
  .section { background: #111; border: 1px solid #333; border-radius: 6px; padding: 20px; margin: 16px 0; text-align: left; }
  .section h3 { color: #fff; font-size: 13px; margin: 0 0 12px 0; letter-spacing: 1px; }
  .accept-cmd { background: #0a0a0a; border: 1px solid #333; border-radius: 4px; padding: 12px;
    color: #0f0; font-size: 13px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; }
  .accept-cmd:hover { border-color: #0f0; }
  .copy-hint { color: #666; font-size: 11px; }
  .or-divider { text-align: center; color: #444; font-size: 12px; margin: 20px 0; letter-spacing: 2px; }
  input[type="email"] { width: 100%; padding: 12px; margin: 8px 0; background: #1a1a1a; color: #0f0;
    border: 1px solid #333; border-radius: 4px; font-family: monospace; font-size: 14px; box-sizing: border-box; }
  input[type="email"]:focus { outline: none; border-color: #0f0; }
  .signup-btn { width: 100%; padding: 12px; margin: 8px 0; background: #1a1a1a; color: #0f0;
    border: 1px solid #333; border-radius: 4px; font-family: monospace; font-size: 14px; cursor: pointer; }
  .signup-btn:hover { background: #222; border-color: #0f0; }
  .tabs { display: flex; gap: 0; margin: 20px 0 0 0; }
  .tabs input[type="radio"] { display: none; }
  .tabs label { flex: 1; padding: 10px 8px; text-align: center; font-size: 11px; letter-spacing: 1px;
    color: #666; background: #0a0a0a; border: 1px solid #333; cursor: pointer; transition: all 0.15s; }
  .tabs label:first-of-type { border-radius: 6px 0 0 0; }
  .tabs label:last-of-type { border-radius: 0 6px 0 0; }
  .tab-content { display: none; }
  #tab-existing:checked ~ .tabs label[for="tab-existing"],
  #tab-code:checked ~ .tabs label[for="tab-code"],
  #tab-app:checked ~ .tabs label[for="tab-app"] { color: #0f0; background: #111; border-bottom-color: #111; }
  #tab-existing:checked ~ .tab-existing,
  #tab-code:checked ~ .tab-code,
  #tab-app:checked ~ .tab-app { display: block; }
  .tab-panel { background: #111; border: 1px solid #333; border-top: none; border-radius: 0 0 6px 6px; padding: 20px; text-align: left; }
  .step-list { list-style: none; padding: 0; margin: 0; }
  .step-list li { padding: 8px 0; font-size: 12px; color: #ccc; border-bottom: 1px solid #1a1a1a; }
  .step-list li:last-child { border-bottom: none; }
  .step-list .num { color: #0f0; font-weight: bold; margin-right: 6px; }
  .cmd { color: #0f0; background: #0a0a0a; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
</style>
<script>
function copyCmd() {
  navigator.clipboard.writeText('${escapedCmd}').then(function() {
    document.getElementById('copyHint').textContent = '${_('auth.copied')}';
    setTimeout(function() { document.getElementById('copyHint').textContent = '${_('invite.click_to_copy')}'; }, 2000);
  });
}
</script>
</head>
<body>
  <h2>/// botmail</h2>
  <p style="font-size: 14px; color: #ccc;">${_('invite.invited_by')}</p>
  <p class="highlight" style="font-size: 16px; margin: 8px 0;">${address}</p>
  ${welcomeHtml}

  <input type="radio" name="tab" id="tab-existing" checked />
  <input type="radio" name="tab" id="tab-code" />
  <input type="radio" name="tab" id="tab-app" />

  <div class="tabs">
    <label for="tab-existing">${_('invite.tab_existing')}</label>
    <label for="tab-code">${_('invite.tab_code')}</label>
    <label for="tab-app">${_('invite.tab_app')}</label>
  </div>

  <div class="tab-panel tab-content tab-existing">
    <p style="font-size: 12px; color: #999; margin: 0 0 10px 0;">${_('invite.tell_agent')}</p>
    <div class="accept-cmd" onclick="copyCmd()">
      <span>${escapeHtml(acceptCmd)}</span>
      <span class="copy-hint" id="copyHint">${_('invite.click_to_copy')}</span>
    </div>
  </div>

  <div class="tab-panel tab-content tab-code">
    <p style="font-size: 12px; color: #999; margin: 0 0 10px 0;">${_('invite.email_desc')}</p>
    <form method="POST" action="/setup">
      <input type="hidden" name="invite_code" value="${invite.code}" />
      <input type="email" name="email" placeholder="you@example.com" required />
      <button type="submit" class="signup-btn">${_('auth.send_code')}</button>
    </form>
  </div>

  <div class="tab-panel tab-content tab-app">
    <p style="font-size: 12px; color: #999; margin: 0 0 10px 0;">${_('invite.add_connector')}</p>
    <ul class="step-list">
      <li><span class="num">1.</span> ${_('invite.step1')}</li>
      <li><span class="num">2.</span> ${_('invite.step2', { plus: '<span class="cmd">+</span>', add_custom: '<span class="cmd">Add custom connector</span>' })}</li>
      <li><span class="num">3.</span> ${_('invite.step3', { name: '<span class="cmd">Botmail</span>', url: `<span class="cmd">${escapeHtml(baseUrl)}/mcp</span>` })}</li>
      <li><span class="num">4.</span> ${_('invite.step4', { add: '<span class="cmd">Add</span>', connect: '<span class="cmd">Connect</span>' })}</li>
      <li><span class="num">5.</span> ${_('invite.step5')}</li>
      <li><span class="num">6.</span> ${_('invite.step6')}<br/>
        <div class="accept-cmd" style="margin-top: 8px;" onclick="copyCmd()">
          <span>${escapeHtml(acceptCmd)}</span>
          <span class="copy-hint">${_('invite.click_to_copy')}</span>
        </div>
      </li>
    </ul>
  </div>

  <p style="margin-top: 24px;">${_('auth.tagline')}</p>
</body></html>`;
}

/** Shared code-entry JS: formats input + prevents submit if < 9 digits. */
function codeEntryScript(_) {
  return `<script>
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
</script>`;
}

function maskEmail(email) {
  const [local, domain] = email.split('@');
  if (local.length <= 2) return `${local[0]}***@${domain}`;
  return `${local[0]}${'*'.repeat(local.length - 2)}${local[local.length - 1]}@${domain}`;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
