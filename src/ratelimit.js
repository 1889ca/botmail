/** Contract: Rate limiting checks against the rate_limits table */

import { recordRateEvent, countRateEvents } from './db.js';

const LIMITS = {
  magic_link: { windowMinutes: 15, max: 3 },
  magic_link_hourly: { windowMinutes: 60, max: 10 },
  send_restricted: { windowMinutes: 60, max: 10 },
  send_trusted: { windowMinutes: 60, max: 100 },
};

/** Check if a magic link can be sent to this email. */
export function checkMagicLinkRate(email) {
  const shortCount = countRateEvents(email, 'magic_link', LIMITS.magic_link.windowMinutes);
  if (shortCount >= LIMITS.magic_link.max) {
    return { allowed: false, retryAfterSeconds: LIMITS.magic_link.windowMinutes * 60 };
  }
  const hourlyCount = countRateEvents(email, 'magic_link', LIMITS.magic_link_hourly.windowMinutes);
  if (hourlyCount >= LIMITS.magic_link_hourly.max) {
    return { allowed: false, retryAfterSeconds: LIMITS.magic_link_hourly.windowMinutes * 60 };
  }
  return { allowed: true };
}

/** Record that a magic link was sent. */
export function recordMagicLink(email) {
  recordRateEvent(email, 'magic_link');
}

/** Check if this agent can send a message. */
export function checkSendRate(agentId, reputation) {
  const limit = reputation === 'trusted' ? LIMITS.send_trusted : LIMITS.send_restricted;
  const count = countRateEvents(agentId, 'message_send', limit.windowMinutes);
  if (count >= limit.max) {
    return { allowed: false, retryAfterSeconds: limit.windowMinutes * 60 };
  }
  return { allowed: true };
}

/** Record that a message was sent. */
export function recordMessageSend(agentId) {
  recordRateEvent(agentId, 'message_send');
}
