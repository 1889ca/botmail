/** Contract: Auth code generation, email sending via Resend, and account provisioning */

import crypto from 'node:crypto';
import { Resend } from 'resend';
import { createEmailCode, findAccountByEmail, findAccountByHandle, createAccount } from '../db.js';
import { t as createT } from '../i18n.js';

let resend;
function getResend() {
  if (!resend) resend = new Resend(process.env.RESEND_API_KEY);
  return resend;
}
const FROM = process.env.RESEND_FROM_EMAIL || 'botmail <noreply@botmail.dev>';

/** Generate a 9-digit auth code, store its hash, and email the code. Returns the emailCodeId. */
export async function sendAuthCode(email, { pendingAuthId, inviteCode, locale } = {}) {
  const _ = createT(locale || 'en');
  const code = crypto.randomInt(100_000_000, 1_000_000_000).toString();
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  const id = crypto.randomUUID().replace(/-/g, '');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  await createEmailCode({ id, codeHash, email, pendingAuthId, inviteCode, expiresAt });

  const formatted = `${code.slice(0, 3)} ${code.slice(3, 6)} ${code.slice(6)}`;

  await getResend().emails.send({
    from: FROM,
    to: email,
    subject: _('email.subject'),
    text: `${_('email.intro')}\n\n${formatted}\n\n${_('email.expiry')}\n\n${_('email.ignore')}`,
    html: `
      <div style="font-family: monospace; max-width: 480px; margin: 0 auto; padding: 32px; background: #0a0a0a; color: #ccc;">
        <h2 style="color: #fff; letter-spacing: 2px;">${_('email.heading')}</h2>
        <p>${_('email.code_label')}</p>
        <p style="font-size: 32px; color: #0f0; letter-spacing: 8px; text-align: center; margin: 24px 0;">${formatted}</p>
        <p style="color: #666; font-size: 12px;">${_('email.expiry')} ${_('email.ignore')}</p>
      </div>
    `,
  });

  return id;
}

/** Find or create an account for the given email address. */
export async function ensureAccount(email) {
  const existing = await findAccountByEmail(email);
  if (existing) return existing;

  const id = crypto.randomUUID().replace(/-/g, '');
  const handle = await deriveHandle(email);

  await createAccount({ id, email, handle });
  return { id, email, handle, reputation: 'restricted', messages_sent: 0 };
}

/** Derive a unique handle from an email address. */
async function deriveHandle(email) {
  const base = email.split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 28);

  const candidate = base.length >= 3 ? base : base + '-user';
  if (!(await findAccountByHandle(candidate))) return candidate;

  for (let i = 2; i < 100; i++) {
    const suffixed = `${candidate}-${i}`;
    if (!(await findAccountByHandle(suffixed))) return suffixed;
  }

  const suffix = crypto.randomBytes(4).toString('hex');
  return `user-${suffix}`;
}
