/** Contract: SQLite persistence for accounts, projects, instances, and messages */

import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';

let db;

export function init(dbPath = 'data/bmail.db') {
  const dir = dbPath.substring(0, dbPath.lastIndexOf('/'));
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      handle TEXT NOT NULL UNIQUE,
      reputation TEXT DEFAULT 'restricted',
      messages_sent INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      name TEXT NOT NULL,
      public_key TEXT NOT NULL,
      private_key_enc TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(account_id, name),
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );

    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      label TEXT,
      last_seen TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY,
      redirect_uris TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pending_auth (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      state TEXT,
      code_challenge TEXT,
      code_challenge_method TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS magic_links (
      token_hash TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      pending_auth_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (pending_auth_id) REFERENCES pending_auth(id)
    );

    CREATE TABLE IF NOT EXISTS auth_codes (
      code TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT,
      code_challenge_method TEXT,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS access_tokens (
      token_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sender_project_id TEXT NOT NULL,
      sender_instance_id TEXT,
      recipient_project_id TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      nonce TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      read_at TEXT,
      claimed_by TEXT,
      FOREIGN KEY (sender_project_id) REFERENCES projects(id),
      FOREIGN KEY (recipient_project_id) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT NOT NULL,
      action TEXT NOT NULL,
      timestamp TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rate_limits_lookup ON rate_limits(key, action, timestamp);
  `);

  return db;
}

export function getDb() { return db; }

function uid() { return crypto.randomUUID().replace(/-/g, ''); }
function token() { return crypto.randomBytes(48).toString('hex'); }
function hash(val) { return crypto.createHash('sha256').update(val).digest('hex'); }

// --- Accounts ---
export function createAccount({ id, email, handle }) {
  db.prepare('INSERT INTO accounts (id, email, handle) VALUES (?, ?, ?)').run(id, email, handle);
}

export function findAccount(id) {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
}

export function findAccountByEmail(email) {
  return db.prepare('SELECT * FROM accounts WHERE email = ?').get(email);
}

export function findAccountByHandle(handle) {
  return db.prepare('SELECT * FROM accounts WHERE handle = ?').get(handle);
}

export function incrementMessagesSent(accountId) {
  db.prepare('UPDATE accounts SET messages_sent = messages_sent + 1 WHERE id = ?').run(accountId);
}

export function updateReputation(accountId, reputation) {
  db.prepare('UPDATE accounts SET reputation = ? WHERE id = ?').run(reputation, accountId);
}

// --- Projects ---
export function createProject({ id, accountId, name, publicKey, privateKeyEnc }) {
  db.prepare(`INSERT INTO projects (id, account_id, name, public_key, private_key_enc)
    VALUES (?, ?, ?, ?, ?)`).run(id, accountId, name, publicKey, privateKeyEnc);
}

export function findProject(id) {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

export function findProjectByAddress(handle, projectName) {
  return db.prepare(`
    SELECT p.* FROM projects p
    JOIN accounts a ON a.id = p.account_id
    WHERE a.handle = ? AND p.name = ?
  `).get(handle, projectName);
}

export function findProjectByAccountAndName(accountId, name) {
  return db.prepare('SELECT * FROM projects WHERE account_id = ? AND name = ?').get(accountId, name);
}

export function listProjects(accountId) {
  return db.prepare('SELECT * FROM projects WHERE account_id = ? ORDER BY created_at').all(accountId);
}

// --- Instances ---
export function createInstance({ id, projectId, label }) {
  db.prepare('INSERT INTO instances (id, project_id, label) VALUES (?, ?, ?)').run(id, projectId, label);
}

export function touchInstance(id) {
  db.prepare("UPDATE instances SET last_seen = datetime('now') WHERE id = ?").run(id);
}

export function removeInstance(id) {
  db.prepare('DELETE FROM instances WHERE id = ?').run(id);
}

export function listInstances(projectId) {
  return db.prepare('SELECT * FROM instances WHERE project_id = ? ORDER BY last_seen DESC').all(projectId);
}

export function purgeStaleInstances() {
  return db.prepare("DELETE FROM instances WHERE datetime(last_seen, '+24 hours') < datetime('now')").run();
}

// --- OAuth Clients ---
export function registerClient(redirectUris) {
  const clientId = uid();
  db.prepare('INSERT INTO oauth_clients (client_id, redirect_uris) VALUES (?, ?)').run(clientId, JSON.stringify(redirectUris));
  return clientId;
}

export function findClient(clientId) {
  return db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId);
}

// --- Pending Auth ---
export function createPendingAuth(params) {
  const id = uid();
  db.prepare(`INSERT INTO pending_auth (id, client_id, redirect_uri, state, code_challenge, code_challenge_method)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, params.clientId, params.redirectUri, params.state, params.codeChallenge, params.codeChallengeMethod);
  return id;
}

export function findPendingAuth(id) {
  return db.prepare('SELECT * FROM pending_auth WHERE id = ?').get(id);
}

export function deletePendingAuth(id) {
  db.prepare('DELETE FROM pending_auth WHERE id = ?').run(id);
}

// --- Magic Links ---
export function createMagicLink({ tokenHash, email, pendingAuthId, expiresAt }) {
  db.prepare(`INSERT INTO magic_links (token_hash, email, pending_auth_id, expires_at)
    VALUES (?, ?, ?, ?)`).run(tokenHash, email, pendingAuthId, expiresAt);
}

export function consumeMagicLink(rawToken) {
  const h = hash(rawToken);
  const row = db.prepare('SELECT * FROM magic_links WHERE token_hash = ? AND used = 0').get(h);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  db.prepare('UPDATE magic_links SET used = 1 WHERE token_hash = ?').run(h);
  return row;
}

export function purgeExpiredMagicLinks() {
  return db.prepare("DELETE FROM magic_links WHERE used = 1 OR datetime(expires_at) < datetime('now')").run();
}

// --- Auth Codes ---
export function createAuthCode({ clientId, accountId, redirectUri, codeChallenge, codeChallengeMethod }) {
  const code = token();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO auth_codes (code, client_id, account_id, redirect_uri, code_challenge, code_challenge_method, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(code, clientId, accountId, redirectUri, codeChallenge, codeChallengeMethod, expiresAt);
  return code;
}

export function consumeAuthCode(code) {
  const row = db.prepare('SELECT * FROM auth_codes WHERE code = ? AND used = 0').get(code);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  db.prepare('UPDATE auth_codes SET used = 1 WHERE code = ?').run(code);
  return row;
}

// --- Access Tokens ---
export function createAccessToken(accountId) {
  const raw = token();
  db.prepare('INSERT INTO access_tokens (token_hash, account_id) VALUES (?, ?)').run(hash(raw), accountId);
  return raw;
}

export function resolveToken(raw) {
  return db.prepare('SELECT account_id FROM access_tokens WHERE token_hash = ?').get(hash(raw));
}

// --- Rate Limits ---
export function recordRateEvent(key, action) {
  db.prepare('INSERT INTO rate_limits (key, action) VALUES (?, ?)').run(key, action);
}

export function countRateEvents(key, action, windowMinutes) {
  const row = db.prepare(
    `SELECT COUNT(*) as count FROM rate_limits WHERE key = ? AND action = ? AND timestamp > datetime('now', ? || ' minutes')`
  ).get(key, action, `-${windowMinutes}`);
  return row.count;
}

export function purgeOldRateEvents() {
  return db.prepare("DELETE FROM rate_limits WHERE timestamp < datetime('now', '-24 hours')").run();
}

// --- Messages ---
export function storeMessage({ senderProjectId, senderInstanceId, recipientProjectId, ciphertext, nonce }) {
  const id = uid();
  db.prepare(`INSERT INTO messages (id, sender_project_id, sender_instance_id, recipient_project_id, ciphertext, nonce)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, senderProjectId, senderInstanceId, recipientProjectId, ciphertext, nonce);
  return id;
}

export function listInbox(projectId) {
  return db.prepare(`SELECT id, sender_project_id, sender_instance_id, created_at, read_at, claimed_by
    FROM messages WHERE recipient_project_id = ? ORDER BY created_at DESC`).all(projectId);
}

export function getMessage(id, projectId) {
  return db.prepare('SELECT * FROM messages WHERE id = ? AND recipient_project_id = ?').get(id, projectId);
}

export function markRead(id) {
  db.prepare("UPDATE messages SET read_at = datetime('now') WHERE id = ?").run(id);
}

export function claimMessage(id, instanceId) {
  const result = db.prepare('UPDATE messages SET claimed_by = ? WHERE id = ? AND claimed_by IS NULL').run(instanceId, id);
  return result.changes > 0;
}

export function deleteMessage(id, projectId) {
  return db.prepare('DELETE FROM messages WHERE id = ? AND recipient_project_id = ?').run(id, projectId);
}

export function purgeExpiredMessages() {
  return db.prepare("DELETE FROM messages WHERE read_at IS NOT NULL AND datetime(read_at, '+24 hours') < datetime('now')").run();
}

export function purgeExpiredPendingAuth() {
  return db.prepare("DELETE FROM pending_auth WHERE datetime(created_at, '+10 minutes') < datetime('now')").run();
}
