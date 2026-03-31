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

/** Create a new McpServer bound to an authenticated account. */
export function createMcpServer(account) {
  const server = new McpServer({ name: 'botmail', version: '0.3.0' });
  const session = { account, project: null, instance: null };

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

      const isContact = await findContact(session.project.id, recipient.id);
      if (!isContact) {
        return err('Recipient not found or not connected');
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
    'invite',
    'Generate an invite link for your current project',
    {
      welcome_message: z.string().optional().describe('Optional message sent to people who accept the invite'),
      max_uses: z.number().optional().describe('Max number of accepts (omit for unlimited)'),
    },
    async ({ welcome_message, max_uses }) => {
      if (!session.project) return err('Call "join" first to select a project');
      const code = generateInviteCode();
      await createInvite({
        code,
        projectId: session.project.id,
        welcomeMessage: welcome_message,
        maxUses: max_uses,
        createdBy: account.id,
      });
      const url = `${process.env.BASE_URL}/invite/${code}`;
      return ok({ code, url, address: `${account.handle}.${session.project.name}` });
    }
  );

  server.tool(
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

  server.tool(
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
