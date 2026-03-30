/** Contract: MCP server factory — creates per-session servers with hierarchical identity */

import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  findProjectByAccountAndName, findProjectByAddress, findProject,
  createProject, listProjects, createInstance, touchInstance,
  storeMessage, listInbox, getMessage, markRead, claimMessage,
  deleteMessage as dbDeleteMessage, incrementMessagesSent,
  findAccount as dbFindAccount,
} from './db.js';
import { generateKeypair, deriveAgentId, encryptMessage, decryptMessage, decryptPrivateKey } from './crypto.js';
import { checkSendRate, recordMessageSend } from './ratelimit.js';
import { maybeGraduate } from './reputation.js';

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

      let proj = findProjectByAccountAndName(account.id, project);
      if (!proj) {
        const kp = generateKeypair();
        const id = deriveAgentId(kp.publicKey);
        const privateKeyEnc = encryptPrivateKey(kp.privateKey, process.env.MASTER_KEY);
        createProject({ id, accountId: account.id, name: project, publicKey: kp.publicKey, privateKeyEnc });
        proj = { id, account_id: account.id, name: project, public_key: kp.publicKey, private_key_enc: privateKeyEnc };
      }

      const instanceId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
      createInstance({ id: instanceId, projectId: proj.id, label: label || null });

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
      const projects = listProjects(account.id);
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

      const recipient = findProjectByAddress(handle, projectName);
      if (!recipient) return err(`Project "${to}" not found`);
      if (recipient.id === session.project.id) return err('Cannot send to yourself');

      const rate = checkSendRate(account.id, account.reputation);
      if (!rate.allowed) {
        return err(`Rate limit exceeded. Try again in ${Math.ceil(rate.retryAfterSeconds / 60)} minutes.`);
      }

      const senderPrivKey = decryptPrivateKey(session.project.private_key_enc, process.env.MASTER_KEY);
      const { ciphertext, nonce } = encryptMessage(senderPrivKey, recipient.public_key, message);

      const msgId = storeMessage({
        senderProjectId: session.project.id,
        senderInstanceId: session.instance.id,
        recipientProjectId: recipient.id,
        ciphertext,
        nonce,
      });

      recordMessageSend(account.id);
      incrementMessagesSent(account.id);
      account.messages_sent = (account.messages_sent || 0) + 1;
      account.reputation = maybeGraduate(account);

      return ok({ message_id: msgId, to, status: 'sent' });
    }
  );

  server.tool(
    'inbox',
    'List messages in your project inbox (all instances share this inbox)',
    {},
    async () => {
      if (!session.project) return err('Call "join" first to select a project');
      const messages = listInbox(session.project.id);
      return ok({
        address: `${account.handle}.${session.project.name}`,
        count: messages.length,
        messages: messages.map(m => ({
          id: m.id,
          from: resolveSenderAddress(m.sender_project_id),
          received_at: m.created_at,
          read: !!m.read_at,
          claimed_by: m.claimed_by || null,
        })),
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

      const msg = getMessage(message_id, session.project.id);
      if (!msg) return err('Message not found');

      if (claim) {
        const claimed = claimMessage(message_id, session.instance.id);
        if (!claimed) return err('Message already claimed by another instance');
      }

      const senderProject = findProject(msg.sender_project_id);
      if (!senderProject) return err('Sender project no longer exists');

      const recipientPrivKey = decryptPrivateKey(session.project.private_key_enc, process.env.MASTER_KEY);
      const plaintext = decryptMessage(recipientPrivKey, senderProject.public_key, msg.ciphertext, msg.nonce);
      markRead(message_id);

      return ok({
        id: msg.id,
        from: resolveSenderAddress(msg.sender_project_id),
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
      const result = dbDeleteMessage(message_id, session.project.id);
      if (result.changes === 0) return err('Message not found');
      return ok({ deleted: message_id });
    }
  );

  return server;
}

/** Resolve a project ID to its handle.name address. */
function resolveSenderAddress(projectId) {
  const project = findProject(projectId);
  if (!project) return projectId;
  const acct = dbFindAccount(project.account_id);
  return acct ? `${acct.handle}.${project.name}` : projectId;
}

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(message) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}
