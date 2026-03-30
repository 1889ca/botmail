/** Contract: Agent reputation evaluation and graduation logic */

import { updateReputation } from './db.js';

const GRADUATION_DAYS = 7;
const GRADUATION_MESSAGES = 20;

/** Check if a restricted agent should graduate to trusted. Returns the effective reputation. */
export function maybeGraduate(agent) {
  if (agent.reputation === 'trusted') return 'trusted';

  const ageDays = (Date.now() - new Date(agent.created_at).getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays < GRADUATION_DAYS) return 'restricted';
  if (agent.messages_sent < GRADUATION_MESSAGES) return 'restricted';

  updateReputation(agent.id, 'trusted');
  return 'trusted';
}
