/** Contract: Magic link generation, email sending via Resend, and agent provisioning */

import crypto from 'node:crypto';
import { Resend } from 'resend';
import { createMagicLink, findAgentByEmail, createAgent as dbCreateAgent } from '../db.js';
import { generateKeypair, deriveAgentId, encryptPrivateKey } from '../crypto.js';

let resend;
function getResend() {
  if (!resend) resend = new Resend(process.env.RESEND_API_KEY);
  return resend;
}
const FROM = process.env.RESEND_FROM_EMAIL || 'bmail <noreply@bmail.dev>';

/** Generate a magic link token, store its hash, and email the link. */
export async function sendMagicLink(email, pendingAuthId) {
  const raw = crypto.randomBytes(48).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  createMagicLink({ tokenHash, email, pendingAuthId, expiresAt });

  const base = process.env.BASE_URL;
  const link = `${base}/oauth/verify?token=${raw}`;

  await getResend().emails.send({
    from: FROM,
    to: email,
    subject: 'Your bmail sign-in link',
    text: `Click this link to sign in to bmail:\n\n${link}\n\nThis link expires in 15 minutes.\n\nIf you didn't request this, ignore this email.`,
    html: `
      <div style="font-family: monospace; max-width: 480px; margin: 0 auto; padding: 32px; background: #0a0a0a; color: #ccc;">
        <h2 style="color: #fff; letter-spacing: 2px;">/// bmail</h2>
        <p>Click the link below to sign in:</p>
        <p><a href="${link}" style="color: #0f0;">${link}</a></p>
        <p style="color: #666; font-size: 12px;">This link expires in 15 minutes. If you didn't request this, ignore this email.</p>
      </div>
    `,
  });
}

/** Find or create an agent for the given email address. */
export function ensureAgent(email) {
  const existing = findAgentByEmail(email);
  if (existing) return existing;

  const kp = generateKeypair();
  const id = deriveAgentId(kp.publicKey);
  const privateKeyEnc = encryptPrivateKey(kp.privateKey, process.env.MASTER_KEY);

  dbCreateAgent({ id, email, displayName: email.split('@')[0], publicKey: kp.publicKey, privateKeyEnc });
  return { id, email, public_key: kp.publicKey, private_key_enc: privateKeyEnc, reputation: 'restricted', messages_sent: 0 };
}
