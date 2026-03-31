/** Contract: Rate limiting checks against the rate_limits table */

import { recordRateEvent, countRateEvents } from './db.js';

const LIMITS = {
  magic_link: { windowMinutes: 15, max: 3 },
  magic_link_hourly: { windowMinutes: 60, max: 10 },
  send_restricted: { windowMinutes: 60, max: 10 },
  send_trusted: { windowMinutes: 60, max: 100 },
  accept_invite: { windowMinutes: 60, max: 20 },
};

/** Check if a magic link can be sent to this email. */
export async function checkMagicLinkRate(email) {
  const shortCount = await countRateEvents(email, 'magic_link', LIMITS.magic_link.windowMinutes);
  if (shortCount >= LIMITS.magic_link.max) {
    return { allowed: false, retryAfterSeconds: LIMITS.magic_link.windowMinutes * 60 };
  }
  const hourlyCount = await countRateEvents(email, 'magic_link', LIMITS.magic_link_hourly.windowMinutes);
  if (hourlyCount >= LIMITS.magic_link_hourly.max) {
    return { allowed: false, retryAfterSeconds: LIMITS.magic_link_hourly.windowMinutes * 60 };
  }
  return { allowed: true };
}

/** Record that a magic link was sent. */
export async function recordMagicLink(email) {
  await recordRateEvent(email, 'magic_link');
}

/** Check if this account can send a message. */
export async function checkSendRate(accountId, reputation) {
  const limit = reputation === 'trusted' ? LIMITS.send_trusted : LIMITS.send_restricted;
  const count = await countRateEvents(accountId, 'message_send', limit.windowMinutes);
  if (count >= limit.max) {
    return { allowed: false, retryAfterSeconds: limit.windowMinutes * 60 };
  }
  return { allowed: true };
}

/** Record that a message was sent. */
export async function recordMessageSend(accountId) {
  await recordRateEvent(accountId, 'message_send');
}

/** Check if this account can accept an invite. */
export async function checkAcceptRate(accountId) {
  const limit = LIMITS.accept_invite;
  const count = await countRateEvents(accountId, 'accept_invite', limit.windowMinutes);
  if (count >= limit.max) {
    return { allowed: false, retryAfterSeconds: limit.windowMinutes * 60 };
  }
  return { allowed: true };
}

/** Record that an invite was accepted. */
export async function recordAcceptInvite(accountId) {
  await recordRateEvent(accountId, 'accept_invite');
}
