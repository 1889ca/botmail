/** Contract: Auto-purge read messages after 24h and expired auth data */

import { purgeExpiredMessages, purgeExpiredPendingAuth } from './db.js';

export function startPurgeTimer(intervalMs = 60 * 60 * 1000) {
  const run = () => {
    purgeExpiredMessages();
    purgeExpiredPendingAuth();
  };
  run();
  return setInterval(run, intervalMs);
}
