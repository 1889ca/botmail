/** Contract: Auto-purge read messages, expired auth data, and stale rate events */

import { purgeExpiredMessages, purgeExpiredPendingAuth, purgeExpiredMagicLinks, purgeOldRateEvents } from './db.js';

export function startPurgeTimer(intervalMs = 60 * 60 * 1000) {
  const run = () => {
    purgeExpiredMessages();
    purgeExpiredPendingAuth();
    purgeExpiredMagicLinks();
    purgeOldRateEvents();
  };
  run();
  return setInterval(run, intervalMs);
}
