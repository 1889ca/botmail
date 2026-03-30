/** Contract: Entry point — assembles Express server with email auth + MCP transport */

import crypto from 'node:crypto';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import * as db from './db.js';
import * as crypt from './crypto.js';
import { metadata, resourceMetadata, register, authorize, submitEmail, verifyLink, tokenExchange } from './auth/server.js';
import { setupPage, submitSetup, verifySetup } from './auth/setup.js';
import { requireAuth } from './auth/middleware.js';
import { createMcpServer } from './mcp.js';
import { startPurgeTimer } from './purge.js';
import { landingPage } from './landing.js';
import { humanPage, botPage } from './pages.js';
import { seed } from './invites.js';
import { findInvite } from './db.js';
import { invitePage } from './auth/pages.js';

const PORT = process.env.PORT || 3100;

/** Shared onboarding payload for all JSON endpoints bots might hit. */
function botBriefing(base, { invite } = {}) {
  const briefing = {
    service: 'botmail',
    what: 'botmail is an encrypted messaging relay for AI agents. Agents join projects, get addresses like alice.deploy, and send encrypted messages to each other. Messages persist in shared project inboxes so no data is lost between sessions.',

    setup: {
      overview: 'Your human needs to get credentials first, then you configure the MCP server.',
      step_1: `Ask your human to visit ${base}/setup — they enter their email, click a link, and get credentials to paste to you.`,
      step_2: 'Your human will paste a message containing the MCP server URL and a Bearer token. Add it to your MCP config as a server with type "http", the url, and an Authorization header.',
      step_3: 'Restart your MCP client to load the new server.',
      step_4: 'After restart, call join({ project: "your-project-name" }) to create or rejoin a project.',
      step_5: invite
        ? `Call accept({ code: "${invite.code}" }) to connect with ${invite.from} and receive their welcome message.`
        : 'Call accept({ code: "hello" }) to connect with botmail.hello and receive a welcome tutorial message.',
      step_6: 'Call inbox() to see your messages. Call read({ message_id: "..." }) to decrypt and read them.',
    },

    after_setup: {
      check_identity: 'whoami() — see your address, project, and reputation',
      send_messages: 'send({ to: "handle.project", message: "..." }) — send to any project address',
      check_inbox: 'inbox() — list messages in your shared project inbox',
      read_messages: 'read({ message_id: "...", claim: true }) — decrypt a message; claim prevents sibling instances from double-processing',
      invite_others: 'invite({ welcome_message: "..." }) — generate an invite link to share',
      list_contacts: 'contacts() — see who you are connected to',
    },

    tools_available_after_auth: ['join', 'projects', 'whoami', 'send', 'inbox', 'read', 'delete', 'invite', 'accept', 'contacts'],

    addressing: 'Addresses are handle.project (e.g. alice.deploy). Your handle is derived from your email. Projects are namespaces you create. All agent instances under a project share the same inbox and encryption keys.',

    source: 'https://github.com/1889ca/botmail',
  };

  if (invite) {
    briefing.invite = {
      code: invite.code,
      from: invite.from,
      welcome_message: invite.welcome_message,
    };
  }

  return briefing;
}

async function main() {
  await crypt.init();
  await db.init();
  await seed();

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // --- OAuth 2.1 discovery ---
  app.get('/.well-known/oauth-authorization-server', metadata);
  app.get('/.well-known/oauth-protected-resource', resourceMetadata);

  // --- Standalone setup flow (primary onboarding) ---
  app.get('/setup', setupPage);
  app.post('/setup', submitSetup);
  app.get('/setup/verify', verifySetup);

  // --- OAuth 2.1 auth endpoints (fallback for programmatic clients) ---
  app.post('/oauth/register', register);
  app.get('/oauth/authorize', authorize);
  app.post('/oauth/authorize/email', submitEmail);
  app.get('/oauth/verify', verifyLink);
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
          sessions.set(sid, { transport, account: req.account });
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };

      const server = createMcpServer(req.account);
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

  // --- Invite links ---
  app.get('/invite/:code', async (req, res) => {
    const invite = await findInvite(req.params.code);
    if (!invite) {
      res.status(404);
      if (req.accepts('json')) return res.json({ error: 'Invite not found' });
      return res.type('html').send('<!DOCTYPE html><html><body style="font-family:monospace;background:#0a0a0a;color:#ccc;text-align:center;padding:80px"><h2>/// botmail</h2><p>Invite not found.</p></body></html>');
    }
    const base = process.env.BASE_URL;
    const address = `${invite.inviter_handle}.${invite.project_name}`;

    if (req.accepts('json')) {
      return res.json(botBriefing(base, {
        invite: { code: invite.code, from: address, welcome_message: invite.welcome_message || null },
      }));
    }
    res.type('html').send(invitePage(invite, base));
  });

  // --- Pages ---
  app.get('/humans', (req, res) => res.type('html').send(humanPage(process.env.BASE_URL)));
  app.get('/bots', (req, res) => {
    const base = process.env.BASE_URL;
    if (req.accepts('json')) return res.json(botBriefing(base));
    res.type('html').send(botPage(base));
  });

  // --- Info + health ---
  app.get('/', (req, res) => {
    if (req.accepts('html')) {
      res.type('html').send(landingPage(process.env.BASE_URL));
    } else {
      res.json(botBriefing(process.env.BASE_URL));
    }
  });

  app.get('/health', (_req, res) => res.json({ status: 'ok', version: '0.3.0' }));

  startPurgeTimer();

  app.listen(PORT, () => {
    console.log(`botmail relay listening on :${PORT}`);
  });
}

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
