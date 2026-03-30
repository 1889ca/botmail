/** Contract: SQLite persistence for agents, OAuth, and messages */

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
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      display_name TEXT,
      public_key TEXT NOT NULL,
      private_key_enc TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(provider, provider_id)
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
      provider TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS auth_codes (
      code TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT,
      code_challenge_method TEXT,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS access_tokens (
      token_hash TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      nonce TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      read_at TEXT,
      FOREIGN KEY (sender_id) REFERENCES agents(id),
      FOREIGN KEY (recipient_id) REFERENCES agents(id)
    );
  `);

  return db;
}

export function getDb() { return db; }

function uid() { return crypto.randomUUID().replace(/-/g, ''); }
function token() { return crypto.randomBytes(48).toString('hex'); }
function hash(val) { return crypto.createHash('sha256').update(val).digest('hex'); }

// --- Agents ---
export function createAgent({ id, provider, providerId, displayName, publicKey, privateKeyEnc }) {
  db.prepare(`INSERT INTO agents (id, provider, provider_id, display_name, public_key, private_key_enc)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, provider, providerId, displayName, publicKey, privateKeyEnc);
}

export function findAgentByProvider(provider, providerId) {
  return db.prepare('SELECT * FROM agents WHERE provider = ? AND provider_id = ?').get(provider, providerId);
}

export function findAgent(id) {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
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
  db.prepare(`INSERT INTO pending_auth (id, client_id, redirect_uri, state, code_challenge, code_challenge_method, provider)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, params.clientId, params.redirectUri, params.state, params.codeChallenge, params.codeChallengeMethod, params.provider);
  return id;
}

export function findPendingAuth(id) {
  return db.prepare('SELECT * FROM pending_auth WHERE id = ?').get(id);
}

export function deletePendingAuth(id) {
  db.prepare('DELETE FROM pending_auth WHERE id = ?').run(id);
}

// --- Auth Codes ---
export function createAuthCode({ clientId, agentId, redirectUri, codeChallenge, codeChallengeMethod }) {
  const code = token();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO auth_codes (code, client_id, agent_id, redirect_uri, code_challenge, code_challenge_method, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(code, clientId, agentId, redirectUri, codeChallenge, codeChallengeMethod, expiresAt);
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
export function createAccessToken(agentId) {
  const raw = token();
  db.prepare('INSERT INTO access_tokens (token_hash, agent_id) VALUES (?, ?)').run(hash(raw), agentId);
  return raw;
}

export function resolveToken(raw) {
  return db.prepare('SELECT agent_id FROM access_tokens WHERE token_hash = ?').get(hash(raw));
}

// --- Messages ---
export function storeMessage({ senderId, recipientId, ciphertext, nonce }) {
  const id = uid();
  db.prepare(`INSERT INTO messages (id, sender_id, recipient_id, ciphertext, nonce)
    VALUES (?, ?, ?, ?, ?)`).run(id, senderId, recipientId, ciphertext, nonce);
  return id;
}

export function listInbox(agentId) {
  return db.prepare(`SELECT id, sender_id, created_at, read_at FROM messages
    WHERE recipient_id = ? ORDER BY created_at DESC`).all(agentId);
}

export function getMessage(id, agentId) {
  return db.prepare('SELECT * FROM messages WHERE id = ? AND recipient_id = ?').get(id, agentId);
}

export function markRead(id) {
  db.prepare("UPDATE messages SET read_at = datetime('now') WHERE id = ?").run(id);
}

export function deleteMessage(id, agentId) {
  return db.prepare('DELETE FROM messages WHERE id = ? AND recipient_id = ?').run(id, agentId);
}

export function purgeExpiredMessages() {
  return db.prepare("DELETE FROM messages WHERE read_at IS NOT NULL AND datetime(read_at, '+24 hours') < datetime('now')").run();
}

export function purgeExpiredPendingAuth() {
  return db.prepare("DELETE FROM pending_auth WHERE datetime(created_at, '+10 minutes') < datetime('now')").run();
}
