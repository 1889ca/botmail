/** Contract: Entry point — assembles Express server with OAuth + MCP transport */

import crypto from 'node:crypto';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import * as db from './db.js';
import * as crypt from './crypto.js';
import { metadata, resourceMetadata, register, authorize, tokenExchange } from './auth/server.js';
import { githubCallback, googleCallback } from './auth/callback.js';
import { requireAuth } from './auth/middleware.js';
import { createMcpServer } from './mcp.js';
import { startPurgeTimer } from './purge.js';

const PORT = process.env.PORT || 3100;

async function main() {
  await crypt.init();
  db.init();

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // --- OAuth 2.1 discovery ---
  app.get('/.well-known/oauth-authorization-server', metadata);
  app.get('/.well-known/oauth-protected-resource', resourceMetadata);

  // --- OAuth endpoints ---
  app.post('/oauth/register', register);
  app.get('/oauth/authorize', authorize);
  app.get('/oauth/callback/github', githubCallback);
  app.get('/oauth/callback/google', googleCallback);
  app.post('/oauth/token', tokenExchange);

  // --- MCP transport (Streamable HTTP) ---
  const sessions = new Map();

  app.post('/mcp', requireAuth, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];

    if (sessionId && sessions.has(sessionId)) {
      const { transport } = sessions.get(sessionId);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, { transport, agent: req.agent });
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };

      const server = createMcpServer(req.agent);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: no valid session' },
      id: null,
    });
  });

  app.get('/mcp', requireAuth, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).send('Invalid or missing session');
      return;
    }
    await sessions.get(sessionId).transport.handleRequest(req, res);
  });

  app.delete('/mcp', requireAuth, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).send('Invalid or missing session');
      return;
    }
    await sessions.get(sessionId).transport.handleRequest(req, res);
  });

  // --- Health check ---
  app.get('/health', (_req, res) => res.json({ status: 'ok', version: '0.1.0' }));

  startPurgeTimer();

  app.listen(PORT, () => {
    console.log(`bmail relay listening on :${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
