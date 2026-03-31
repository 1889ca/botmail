/** Contract: Auto-purge read messages, expired auth data, stale instances, and rate events */

import { purgeExpiredMessages, purgeExpiredPendingAuth, purgeExpiredEmailCodes, purgeOldRateEvents, purgeStaleInstances, purgeExpiredTokens, purgeExpiredInvites } from './db.js';

export function startPurgeTimer(intervalMs = 60 * 60 * 1000) {
  const run = async () => {
    await purgeExpiredMessages();
    await purgeExpiredPendingAuth();
    await purgeExpiredEmailCodes();
    await purgeOldRateEvents();
    await purgeStaleInstances();
    await purgeExpiredTokens();
    await purgeExpiredInvites();
  };
  run();
  return setInterval(run, intervalMs);
}
