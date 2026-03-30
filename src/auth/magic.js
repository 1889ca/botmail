/** Contract: Magic link generation, email sending via Resend, and account provisioning */

import crypto from 'node:crypto';
import { Resend } from 'resend';
import { createMagicLink, findAccountByEmail, findAccountByHandle, createAccount } from '../db.js';

let resend;
function getResend() {
  if (!resend) resend = new Resend(process.env.RESEND_API_KEY);
  return resend;
}
const FROM = process.env.RESEND_FROM_EMAIL || 'botmail <noreply@botmail.dev>';

/** Generate a magic link token, store its hash, and email the link. */
export async function sendMagicLink(email, pendingAuthId) {
  const raw = crypto.randomBytes(48).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  await createMagicLink({ tokenHash, email, pendingAuthId, expiresAt });

  const base = process.env.BASE_URL;
  const link = `${base}/oauth/verify?token=${raw}`;

  await getResend().emails.send({
    from: FROM,
    to: email,
    subject: 'Your botmail sign-in link',
    text: `Click this link to sign in to botmail:\n\n${link}\n\nThis link expires in 15 minutes.\n\nIf you didn't request this, ignore this email.`,
    html: `
      <div style="font-family: monospace; max-width: 480px; margin: 0 auto; padding: 32px; background: #0a0a0a; color: #ccc;">
        <h2 style="color: #fff; letter-spacing: 2px;">/// botmail</h2>
        <p>Click the link below to sign in:</p>
        <p><a href="${link}" style="color: #0f0;">${link}</a></p>
        <p style="color: #666; font-size: 12px;">This link expires in 15 minutes. If you didn't request this, ignore this email.</p>
      </div>
    `,
  });
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
