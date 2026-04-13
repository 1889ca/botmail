/** Contract: Auto-purge read messages, expired auth data, stale instances, and rate events */

import { purgeExpiredMessages, purgeExpiredPendingAuth, purgeExpiredEmailCodes, purgeOldRateEvents, purgeStaleInstances, purgeExpiredTokens, purgeExpiredInvites } from './db.js';

export function startPurgeTimer(intervalMs = 60 * 60 * 1000) {
  const jobs = [
    purgeExpiredMessages,
    purgeExpiredEmailCodes,
    purgeExpiredPendingAuth,
    purgeOldRateEvents,
    purgeStaleInstances,
    purgeExpiredTokens,
    purgeExpiredInvites,
  ];

  const run = async () => {
    for (const job of jobs) {
      try {
        await job();
      } catch (e) {
        console.error(`[purge:${job.name}] ${e.message}`);
      }
    }
  };

  run();
  return setInterval(run, intervalMs);
}
