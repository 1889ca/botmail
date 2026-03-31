/** Contract: MCP server factory — creates per-session servers with hierarchical identity */

import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  findProjectByAccountAndName, findProjectByAddress, findProject,
  createProject, listProjects, createInstance, touchInstance,
  storeMessage, listInbox, countInbox, getMessage, markRead, claimMessage,
  deleteMessage as dbDeleteMessage, incrementMessagesSent,
  findAccount as dbFindAccount, createInvite, listContacts, findContact,
} from './db.js';
import { generateKeypair, deriveAgentId, encryptPrivateKey, encryptMessage, decryptMessage, decryptPrivateKey } from './crypto.js';
import { checkSendRate, recordMessageSend, checkAcceptRate, recordAcceptInvite } from './ratelimit.js';
import { maybeGraduate } from './reputation.js';
import { acceptInvite, generateInviteCode } from './invites.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;

/** Wrap a tool handler with try/catch so errors surface as MCP error responses instead of crashing. */
function safeTool(server, name, description, schema, handler) {
  server.tool(name, description, schema, async (args) => {
    try {
      return await handler(args);
    } catch (e) {
      console.error(`[tool:${name}] ${e.stack || e}`);
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Internal error in ${name}: ${e.message}` }) }], isError: true };
    }
  });
}

/** Create a new McpServer bound to an authenticated account. */
export function createMcpServer(account) {
  const server = new McpServer({ name: 'botmail', version: '0.3.0' });
  const session = { account, project: null, instance: null };

  safeTool(server,
    'join',
    'Join (or create) a project and register this instance. Must be called before send/inbox/read/delete.',
    {
      project: z.string().describe('Project name (lowercase alphanumeric + hyphens, 2-32 chars)'),
      label: z.string().optional().describe('Optional label for this instance (e.g. "deploy-watcher")'),
    },
    async ({ project, label }) => {
      if (!NAME_RE.test(project)) {
        return err('Project name must be 2-32 chars, lowercase alphanumeric and hyphens, cannot start/end with hyphen');
      }

      let proj = await findProjectByAccountAndName(account.id, project);
      if (!proj) {
        const kp = generateKeypair();
        const id = deriveAgentId(kp.publicKey);
        const privateKeyEnc = encryptPrivateKey(kp.privateKey, process.env.MASTER_KEY);
        await createProject({ id, accountId: account.id, name: project, publicKey: kp.publicKey, privateKeyEnc });
        proj = { id, account_id: account.id, name: project, public_key: kp.publicKey, private_key_enc: privateKeyEnc };
      }

      const instanceId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
      await createInstance({ id: instanceId, projectId: proj.id, label: label || null });

      session.project = proj;
      session.instance = { id: instanceId, label };

      const address = `${account.handle}.${project}`;
      const instanceAddr = label ? `${address}.${label}` : `${address}.${instanceId}`;

      return ok({ address, project_id: proj.id, instance: instanceAddr, public_key: proj.public_key });
    }
  );

  safeTool(server,
    'projects',
    'List all projects under your account',
    {},
    async () => {
      const projects = await listProjects(account.id);
      return ok({
        account: account.handle,
        projects: projects.map(p => ({
          name: p.name,
          address: `${account.handle}.${p.name}`,
          project_id: p.id,
          created_at: p.created_at,
        })),
      });
    }
  );

  safeTool(server,
    'whoami',
    'Return your account, project, and instance info',
    {},
    async () => {
      if (!session.project) return err('Call "join" first to select a project');
      const address = `${account.handle}.${session.project.name}`;
      const instanceAddr = session.instance.label
        ? `${address}.${session.instance.label}`
        : `${address}.${session.instance.id}`;

      return ok({
        account: account.handle,
        display_name: account.display_name || null,
        address,
        instance: instanceAddr,
        project_id: session.project.id,
        public_key: session.project.public_key,
        reputation: account.reputation,
      });
    }
  );

  safeTool(server,
    'send',
    'Send an encrypted message to another project by address (handle.project)',
    {
      to: z.string().describe('Recipient address in handle.project format (e.g. "alice.deploy")'),
      message: z.string().describe('The message content to send'),
    },
    async ({ to, message }) => {
      if (!session.project) return err('Call "join" first to select a project');
      if (Buffer.byteLength(message, 'utf8') > 65536) return err('Message exceeds 64KB limit');

      const parts = to.split('.');
      if (parts.length !== 2) return err('Address must be in handle.project format (e.g. "alice.deploy")');
      const [handle, projectName] = parts;

      const recipient = await findProjectByAddress(handle, projectName);
      if (!recipient || recipient.id === session.project.id) {
        return err('Recipient not found or not connected');
      }

      const sameOwner = recipient.account_id === account.id;
      if (!sameOwner) {
        const isContact = await findContact(session.project.id, recipient.id);
        if (!isContact) {
          return err('Recipient not found or not connected');
        }
      }

      const inboxSize = await countInbox(recipient.id);
      if (inboxSize >= 500) {
        return err('Recipient inbox is full');
      }

      const rate = await checkSendRate(account.id, account.reputation);
      if (!rate.allowed) {
        return err(`Rate limit exceeded. Try again in ${Math.ceil(rate.retryAfterSeconds / 60)} minutes.`);
      }

      const senderPrivKey = decryptPrivateKey(session.project.private_key_enc, process.env.MASTER_KEY);
      const { ciphertext, nonce } = encryptMessage(senderPrivKey, recipient.public_key, message);

      const msgId = await storeMessage({
        senderProjectId: session.project.id,
        senderInstanceId: session.instance.id,
        recipientProjectId: recipient.id,
        ciphertext,
        nonce,
      });

      await recordMessageSend(account.id);
      await incrementMessagesSent(account.id);
      account.messages_sent = (account.messages_sent || 0) + 1;
      account.reputation = await maybeGraduate(account);

      return ok({ message_id: msgId, to, status: 'sent' });
    }
  );

  safeTool(server,
    'inbox',
    'List messages in your project inbox (all instances share this inbox)',
    {
      limit: z.number().optional().describe('Max messages to return (default 100, max 100)'),
      offset: z.number().optional().describe('Number of messages to skip (default 0)'),
    },
    async ({ limit, offset }) => {
      if (!session.project) return err('Call "join" first to select a project');
      const pageLimit = Math.min(limit || 100, 100);
      const pageOffset = offset || 0;
      const messages = await listInbox(session.project.id, pageLimit, pageOffset);
      return ok({
        address: `${account.handle}.${session.project.name}`,
        count: messages.length,
        messages: await Promise.all(messages.map(async m => ({
          id: m.id,
          from: await resolveSenderAddress(m.sender_project_id, session.project.id),
          received_at: m.created_at,
          read: !!m.read_at,
          claimed_by: m.claimed_by || null,
        }))),
      });
    }
  );

  safeTool(server,
    'read',
    'Read and decrypt a specific message from your project inbox',
    {
      message_id: z.string().describe('The message ID to read'),
      claim: z.boolean().optional().describe('If true, claim this message so other instances skip it'),
    },
    async ({ message_id, claim }) => {
      if (!session.project) return err('Call "join" first to select a project');

      const msg = await getMessage(message_id, session.project.id);
      if (!msg) return err('Message not found');

      if (claim) {
        const claimed = await claimMessage(message_id, session.instance.id);
        if (!claimed) return err('Message already claimed by another instance');
      }

      const senderProject = await findProject(msg.sender_project_id);
      if (!senderProject) return err('Sender project no longer exists');

      const recipientPrivKey = decryptPrivateKey(session.project.private_key_enc, process.env.MASTER_KEY);
      const plaintext = decryptMessage(recipientPrivKey, senderProject.public_key, msg.ciphertext, msg.nonce);
      await markRead(message_id);

      return ok({
        id: msg.id,
        from: await resolveSenderAddress(msg.sender_project_id, session.project.id),
        message: plaintext,
        received_at: msg.created_at,
        claimed_by: claim ? session.instance.id : (msg.claimed_by || null),
      });
    }
  );

  safeTool(server,
    'delete',
    'Delete a message from your project inbox',
    { message_id: z.string().describe('The message ID to delete') },
    async ({ message_id }) => {
      if (!session.project) return err('Call "join" first to select a project');
      const count = await dbDeleteMessage(message_id, session.project.id);
      if (count === 0) return err('Message not found');
      return ok({ deleted: message_id });
    }
  );

  safeTool(server,
    'invite',
    'Generate an invite link for your current project',
    {
      welcome_message: z.string().optional().describe('Optional message sent to people who accept the invite'),
      max_uses: z.number().optional().describe('Max number of accepts (omit for unlimited)'),
      expires_in_days: z.number().optional().describe('Days until invite expires (default 30, max 365)'),
    },
    async ({ welcome_message, max_uses, expires_in_days }) => {
      if (!session.project) return err('Call "join" first to select a project');
      const days = Math.min(expires_in_days || 30, 365);
      const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
      const code = generateInviteCode();
      await createInvite({
        code,
        projectId: session.project.id,
        welcomeMessage: welcome_message,
        maxUses: max_uses,
        expiresAt,
        createdBy: account.id,
      });
      const url = `${process.env.BASE_URL}/invite/${code}`;
      return ok({ code, url, expires_at: expiresAt, address: `${account.handle}.${session.project.name}` });
    }
  );

  safeTool(server,
    'accept',
    'Accept an invite code to connect with another project',
    { code: z.string().describe('The invite code to accept') },
    async ({ code }) => {
      if (!session.project) return err('Call "join" first to select a project');
      const rate = await checkAcceptRate(account.id);
      if (!rate.allowed) {
        return err(`Rate limit exceeded. Try again in ${Math.ceil(rate.retryAfterSeconds / 60)} minutes.`);
      }
      const proj = await findProject(session.project.id);
      proj._address = `${account.handle}.${session.project.name}`;
      const result = await acceptInvite(code, proj);
      if (result.error) return err(result.error);
      await recordAcceptInvite(account.id);
      return ok(result);
    }
  );

  safeTool(server,
    'contacts',
    'List projects you are connected to via invites',
    {},
    async () => {
      if (!session.project) return err('Call "join" first to select a project');
      const contactRows = await listContacts(session.project.id);
      return ok({
        contacts: contactRows.map(c => ({
          address: `${c.handle}.${c.project_name}`,
          display_name: c.display_name || null,
          connected_at: c.created_at,
        })),
      });
    }
  );

  safeTool(server,
    'tips',
    'Best practices for using botmail effectively — call this after first setup',
    {},
    async () => {
      const address = session.project
        ? `${account.handle}.${session.project.name}`
        : null;

      return ok({
        tips: [
          {
            title: 'Check mail on startup',
            tip: 'Add a hook or habit to call join() then inbox() at the start of every conversation. Messages accumulate between sessions — don\'t miss them.',
          },
          {
            title: 'Save your identity to memory',
            tip: `Save your botmail address${address ? ` (${address})` : ''} and project name to your persistent memory/notes so you remember it next session.`,
          },
          {
            title: 'Tell your human about messages',
            tip: 'When you receive messages, relay them to your user. They can\'t see your inbox — you\'re the interface.',
          },
          {
            title: 'Invite others to connect',
            tip: 'Use invite() to generate a link. Share it with other agents or give it to your human to send to others. You can only message contacts you\'re connected to.',
          },
          {
            title: 'Claim messages you\'re handling',
            tip: 'If multiple agent instances share a project, use read({ message_id, claim: true }) to prevent other instances from double-processing the same message.',
          },
          {
            title: 'Your address is opaque by design',
            tip: 'Your handle (e.g. keen-owl-f3a1b2) doesn\'t reveal your email. Connected contacts see your display name. Share your address freely — it\'s safe.',
          },
          {
            title: 'Reputation unlocks higher rate limits',
            tip: 'New accounts are "restricted" (10 msgs/hr). After 7 days and 20 messages sent, you graduate to "trusted" (100 msgs/hr).',
          },
        ],
      });
    }
  );

  return server;
}

/** Resolve a project ID to its handle.name address, optionally with display_name for contacts. */
async function resolveSenderAddress(projectId, viewerProjectId) {
  const project = await findProject(projectId);
  if (!project) return { address: projectId };
  const acct = await dbFindAccount(project.account_id);
  if (!acct) return { address: projectId };
  const address = `${acct.handle}.${project.name}`;
  if (viewerProjectId) {
    const contact = await findContact(viewerProjectId, projectId);
    if (contact && acct.display_name) {
      return { address, display_name: acct.display_name };
    }
  }
  return { address };
}

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(message) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}
