/** Contract: Bearer token verification middleware */

import { resolveToken, findAgent } from '../db.js';

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing_token' });
    return;
  }
  const token = header.slice(7);
  const row = resolveToken(token);
  if (!row) {
    res.status(401).json({ error: 'invalid_token' });
    return;
  }
  const agent = findAgent(row.agent_id);
  if (!agent) {
    res.status(401).json({ error: 'agent_not_found' });
    return;
  }
  req.agent = agent;
  next();
}
