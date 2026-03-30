/** Contract: Bearer token verification middleware */

import { resolveToken, findAccount } from '../db.js';

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing_token' });
    return;
  }
  const token = header.slice(7);
  const row = await resolveToken(token);
  if (!row) {
    res.status(401).json({ error: 'invalid_token' });
    return;
  }
  const account = await findAccount(row.account_id);
  if (!account) {
    res.status(401).json({ error: 'account_not_found' });
    return;
  }
  req.account = account;
  next();
}
