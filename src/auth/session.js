/** Contract: Browser session cookie — signed account ID for cross-flow auth */

import crypto from 'node:crypto';
import { findAccount } from '../db.js';

const COOKIE_NAME = 'botmail_sid';
const MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

function sign(value) {
  const key = process.env.MASTER_KEY;
  return crypto.createHmac('sha256', key).update(value).digest('hex').slice(0, 32);
}

/** Set a signed session cookie on the response. */
export function setSessionCookie(res, accountId) {
  const sig = sign(accountId);
  const secure = (process.env.BASE_URL || '').startsWith('https');
  const parts = [
    `${COOKIE_NAME}=${accountId}.${sig}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${MAX_AGE}`,
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

/** Read and validate the session cookie. Returns account or null. */
export async function getSessionAccount(req) {
  const header = req.headers.cookie;
  if (!header) return null;

  const match = header.split(';').map(c => c.trim()).find(c => c.startsWith(`${COOKIE_NAME}=`));
  if (!match) return null;

  const val = match.slice(COOKIE_NAME.length + 1);
  const dot = val.lastIndexOf('.');
  if (dot < 1) return null;

  const accountId = val.slice(0, dot);
  const sig = val.slice(dot + 1);
  if (sig !== sign(accountId)) return null;

  return findAccount(accountId);
}
