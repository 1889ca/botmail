/** Contract: Postgres persistence for accounts, projects, instances, and messages */

import pg from 'pg';
import crypto from 'node:crypto';

const { Pool } = pg;
let pool;

export async function init() {
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('uselibpqcompat', 'true');
  pool = new Pool({
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      handle TEXT NOT NULL UNIQUE,
      reputation TEXT DEFAULT 'restricted',
      messages_sent INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      name TEXT NOT NULL,
      public_key TEXT NOT NULL,
      private_key_enc TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(account_id, name)
    );

    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      label TEXT,
      last_seen TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY,
      redirect_uris TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pending_auth (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      state TEXT,
      code_challenge TEXT,
      code_challenge_method TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS magic_links (
      token_hash TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      pending_auth_id TEXT NOT NULL REFERENCES pending_auth(id),
      expires_at TIMESTAMPTZ NOT NULL,
      used INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS auth_codes (
      code TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT,
      code_challenge_method TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      used INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS access_tokens (
      token_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sender_project_id TEXT NOT NULL REFERENCES projects(id),
      sender_instance_id TEXT,
      recipient_project_id TEXT NOT NULL REFERENCES projects(id),
      ciphertext TEXT NOT NULL,
      nonce TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      read_at TIMESTAMPTZ,
      claimed_by TEXT
    );

    CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      welcome_message TEXT,
      max_uses INTEGER,
      uses INTEGER DEFAULT 0,
      created_by TEXT NOT NULL REFERENCES accounts(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS contacts (
      project_id TEXT NOT NULL REFERENCES projects(id),
      contact_project_id TEXT NOT NULL REFERENCES projects(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (project_id, contact_project_id)
    );

    CREATE TABLE IF NOT EXISTS setup_tokens (
      token_hash TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      claimed INTEGER DEFAULT 0,
      invite_code TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT NOT NULL,
      action TEXT NOT NULL,
      timestamp TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_rate_limits_lookup ON rate_limits(key, action, timestamp);
  `);

  // Migrations for existing databases
  await pool.query(`ALTER TABLE setup_tokens ADD COLUMN IF NOT EXISTS invite_code TEXT`).catch(() => {});
}

export function getPool() { return pool; }

function uid() { return crypto.randomUUID().replace(/-/g, ''); }
function token() { return crypto.randomBytes(48).toString('hex'); }
function hash(val) { return crypto.createHash('sha256').update(val).digest('hex'); }

async function row(text, params) {
  const { rows } = await pool.query(text, params);
  return rows[0] || null;
}

async function rows(text, params) {
  const { rows: r } = await pool.query(text, params);
  return r;
}

async function run(text, params) {
  const result = await pool.query(text, params);
  return result.rowCount;
}

// --- Accounts ---
export async function createAccount({ id, email, handle }) {
  await pool.query('INSERT INTO accounts (id, email, handle) VALUES ($1, $2, $3)', [id, email, handle]);
}

export async function findAccount(id) {
  return row('SELECT * FROM accounts WHERE id = $1', [id]);
}

export async function findAccountByEmail(email) {
  return row('SELECT * FROM accounts WHERE email = $1', [email]);
}

export async function findAccountByHandle(handle) {
  return row('SELECT * FROM accounts WHERE handle = $1', [handle]);
}

export async function incrementMessagesSent(accountId) {
  await pool.query('UPDATE accounts SET messages_sent = messages_sent + 1 WHERE id = $1', [accountId]);
}

export async function updateReputation(accountId, reputation) {
  await pool.query('UPDATE accounts SET reputation = $1 WHERE id = $2', [reputation, accountId]);
}

// --- Projects ---
export async function createProject({ id, accountId, name, publicKey, privateKeyEnc }) {
  await pool.query(
    'INSERT INTO projects (id, account_id, name, public_key, private_key_enc) VALUES ($1, $2, $3, $4, $5)',
    [id, accountId, name, publicKey, privateKeyEnc],
  );
}

export async function findProject(id) {
  return row('SELECT * FROM projects WHERE id = $1', [id]);
}

export async function findProjectByAddress(handle, projectName) {
  return row(
    'SELECT p.* FROM projects p JOIN accounts a ON a.id = p.account_id WHERE a.handle = $1 AND p.name = $2',
    [handle, projectName],
  );
}

export async function findProjectByAccountAndName(accountId, name) {
  return row('SELECT * FROM projects WHERE account_id = $1 AND name = $2', [accountId, name]);
}

export async function listProjects(accountId) {
  return rows('SELECT * FROM projects WHERE account_id = $1 ORDER BY created_at', [accountId]);
}

// --- Instances ---
export async function createInstance({ id, projectId, label }) {
  await pool.query('INSERT INTO instances (id, project_id, label) VALUES ($1, $2, $3)', [id, projectId, label]);
}

export async function touchInstance(id) {
  await pool.query('UPDATE instances SET last_seen = NOW() WHERE id = $1', [id]);
}

export async function removeInstance(id) {
  await pool.query('DELETE FROM instances WHERE id = $1', [id]);
}

export async function listInstances(projectId) {
  return rows('SELECT * FROM instances WHERE project_id = $1 ORDER BY last_seen DESC', [projectId]);
}

export async function purgeStaleInstances() {
  return run("DELETE FROM instances WHERE last_seen + INTERVAL '24 hours' < NOW()");
}

// --- OAuth Clients ---
export async function registerClient(redirectUris) {
  const clientId = uid();
  await pool.query('INSERT INTO oauth_clients (client_id, redirect_uris) VALUES ($1, $2)', [clientId, JSON.stringify(redirectUris)]);
  return clientId;
}

export async function findClient(clientId) {
  return row('SELECT * FROM oauth_clients WHERE client_id = $1', [clientId]);
}

// --- Pending Auth ---
export async function createPendingAuth(params) {
  const id = uid();
  await pool.query(
    'INSERT INTO pending_auth (id, client_id, redirect_uri, state, code_challenge, code_challenge_method) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, params.clientId, params.redirectUri, params.state, params.codeChallenge, params.codeChallengeMethod],
  );
  return id;
}

export async function findPendingAuth(id) {
  return row('SELECT * FROM pending_auth WHERE id = $1', [id]);
}

export async function deletePendingAuth(id) {
  await pool.query('DELETE FROM pending_auth WHERE id = $1', [id]);
}

// --- Magic Links ---
export async function createMagicLink({ tokenHash, email, pendingAuthId, expiresAt }) {
  await pool.query(
    'INSERT INTO magic_links (token_hash, email, pending_auth_id, expires_at) VALUES ($1, $2, $3, $4)',
    [tokenHash, email, pendingAuthId, expiresAt],
  );
}

export async function consumeMagicLink(rawToken) {
  const h = hash(rawToken);
  const r = await row('SELECT * FROM magic_links WHERE token_hash = $1 AND used = 0', [h]);
  if (!r) return null;
  if (new Date(r.expires_at) < new Date()) return null;
  await pool.query('UPDATE magic_links SET used = 1 WHERE token_hash = $1', [h]);
  return r;
}

// --- Setup Tokens ---
export async function createSetupToken({ tokenHash, email, expiresAt, inviteCode }) {
  await pool.query('INSERT INTO setup_tokens (token_hash, email, expires_at, invite_code) VALUES ($1, $2, $3, $4)', [tokenHash, email, expiresAt, inviteCode || null]);
}

export async function findSetupToken(rawToken) {
  const h = hash(rawToken);
  const r = await row('SELECT * FROM setup_tokens WHERE token_hash = $1 AND claimed = 0', [h]);
  if (!r) return null;
  if (new Date(r.expires_at) < new Date()) return null;
  return r;
}

export async function consumeSetupToken(rawToken) {
  const h = hash(rawToken);
  const r = await findSetupToken(rawToken);
  if (!r) return null;
  await pool.query('UPDATE setup_tokens SET claimed = 1 WHERE token_hash = $1', [h]);
  return r;
}

export async function purgeExpiredSetupTokens() {
  return run("DELETE FROM setup_tokens WHERE claimed = 1 OR expires_at < NOW()");
}

export async function purgeExpiredMagicLinks() {
  return run("DELETE FROM magic_links WHERE used = 1 OR expires_at < NOW()");
}

// --- Auth Codes ---
export async function createAuthCode({ clientId, accountId, redirectUri, codeChallenge, codeChallengeMethod }) {
  const code = token();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await pool.query(
    'INSERT INTO auth_codes (code, client_id, account_id, redirect_uri, code_challenge, code_challenge_method, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [code, clientId, accountId, redirectUri, codeChallenge, codeChallengeMethod, expiresAt],
  );
  return code;
}

export async function consumeAuthCode(code) {
  const r = await row('SELECT * FROM auth_codes WHERE code = $1 AND used = 0', [code]);
  if (!r) return null;
  if (new Date(r.expires_at) < new Date()) return null;
  await pool.query('UPDATE auth_codes SET used = 1 WHERE code = $1', [code]);
  return r;
}

// --- Access Tokens ---
export async function createAccessToken(accountId) {
  const raw = token();
  await pool.query('INSERT INTO access_tokens (token_hash, account_id) VALUES ($1, $2)', [hash(raw), accountId]);
  return raw;
}

export async function resolveToken(raw) {
  return row('SELECT account_id FROM access_tokens WHERE token_hash = $1', [hash(raw)]);
}

// --- Rate Limits ---
export async function recordRateEvent(key, action) {
  await pool.query('INSERT INTO rate_limits (key, action) VALUES ($1, $2)', [key, action]);
}

export async function countRateEvents(key, action, windowMinutes) {
  const r = await row(
    "SELECT COUNT(*) as count FROM rate_limits WHERE key = $1 AND action = $2 AND timestamp > NOW() - ($3 || ' minutes')::INTERVAL",
    [key, action, windowMinutes],
  );
  return parseInt(r.count, 10);
}

export async function purgeOldRateEvents() {
  return run("DELETE FROM rate_limits WHERE timestamp < NOW() - INTERVAL '24 hours'");
}

// --- Messages ---
export async function storeMessage({ senderProjectId, senderInstanceId, recipientProjectId, ciphertext, nonce }) {
  const id = uid();
  await pool.query(
    'INSERT INTO messages (id, sender_project_id, sender_instance_id, recipient_project_id, ciphertext, nonce) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, senderProjectId, senderInstanceId, recipientProjectId, ciphertext, nonce],
  );
  return id;
}

export async function listInbox(projectId) {
  return rows(
    'SELECT id, sender_project_id, sender_instance_id, created_at, read_at, claimed_by FROM messages WHERE recipient_project_id = $1 ORDER BY created_at DESC',
    [projectId],
  );
}

export async function getMessage(id, projectId) {
  return row('SELECT * FROM messages WHERE id = $1 AND recipient_project_id = $2', [id, projectId]);
}

export async function markRead(id) {
  await pool.query('UPDATE messages SET read_at = NOW() WHERE id = $1', [id]);
}

export async function claimMessage(id, instanceId) {
  const count = await run('UPDATE messages SET claimed_by = $1 WHERE id = $2 AND claimed_by IS NULL', [instanceId, id]);
  return count > 0;
}

export async function deleteMessage(id, projectId) {
  return run('DELETE FROM messages WHERE id = $1 AND recipient_project_id = $2', [id, projectId]);
}

export async function purgeExpiredMessages() {
  return run("DELETE FROM messages WHERE read_at IS NOT NULL AND read_at + INTERVAL '24 hours' < NOW()");
}

export async function purgeExpiredPendingAuth() {
  return run("DELETE FROM pending_auth WHERE created_at + INTERVAL '10 minutes' < NOW()");
}

// --- Invites ---
export async function createInvite({ code, projectId, welcomeMessage, maxUses, createdBy }) {
  await pool.query(
    'INSERT INTO invites (code, project_id, welcome_message, max_uses, created_by) VALUES ($1, $2, $3, $4, $5)',
    [code, projectId, welcomeMessage || null, maxUses || null, createdBy],
  );
}

export async function findInvite(code) {
  return row(
    `SELECT i.*, p.name as project_name, p.public_key, p.account_id, a.handle as inviter_handle
     FROM invites i JOIN projects p ON p.id = i.project_id JOIN accounts a ON a.id = p.account_id
     WHERE i.code = $1`,
    [code],
  );
}

export async function incrementInviteUses(code) {
  await pool.query('UPDATE invites SET uses = uses + 1 WHERE code = $1', [code]);
}

// --- Contacts ---
export async function addContact(projectId, contactProjectId) {
  await pool.query('INSERT INTO contacts (project_id, contact_project_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [projectId, contactProjectId]);
  await pool.query('INSERT INTO contacts (project_id, contact_project_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [contactProjectId, projectId]);
}

export async function listContacts(projectId) {
  return rows(
    `SELECT c.contact_project_id, c.created_at, p.name as project_name, a.handle
     FROM contacts c JOIN projects p ON p.id = c.contact_project_id JOIN accounts a ON a.id = p.account_id
     WHERE c.project_id = $1 ORDER BY c.created_at DESC`,
    [projectId],
  );
}

export async function findContact(projectId, contactProjectId) {
  return row('SELECT * FROM contacts WHERE project_id = $1 AND contact_project_id = $2', [projectId, contactProjectId]);
}
