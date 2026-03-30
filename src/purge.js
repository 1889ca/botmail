/** Contract: Auto-purge read messages, expired auth data, stale instances, and rate events */

import { purgeExpiredMessages, purgeExpiredPendingAuth, purgeExpiredMagicLinks, purgeExpiredSetupTokens, purgeOldRateEvents, purgeStaleInstances } from './db.js';

export function startPurgeTimer(intervalMs = 60 * 60 * 1000) {
  const run = async () => {
    await purgeExpiredMessages();
    await purgeExpiredPendingAuth();
    await purgeExpiredMagicLinks();
    await purgeExpiredSetupTokens();
    await purgeOldRateEvents();
    await purgeStaleInstances();
  };
  run();
  return setInterval(run, intervalMs);
}
