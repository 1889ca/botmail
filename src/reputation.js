/** Contract: Account reputation evaluation and graduation logic */

import { updateReputation } from './db.js';

const GRADUATION_DAYS = 7;
const GRADUATION_MESSAGES = 20;

/** Check if a restricted account should graduate to trusted. Returns the effective reputation. */
export async function maybeGraduate(account) {
  if (account.reputation === 'trusted') return 'trusted';

  const ageDays = (Date.now() - new Date(account.created_at).getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays < GRADUATION_DAYS) return 'restricted';
  if (account.messages_sent < GRADUATION_MESSAGES) return 'restricted';

  await updateReputation(account.id, 'trusted');
  return 'trusted';
}
