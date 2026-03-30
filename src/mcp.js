/** Contract: MCP server factory — creates per-session servers bound to an authenticated agent */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  findAgent, storeMessage, listInbox, getMessage, markRead,
  deleteMessage as dbDeleteMessage,
} from './db.js';
import { encryptMessage, decryptMessage, decryptPrivateKey } from './crypto.js';

/** Create a new McpServer bound to a specific authenticated agent. */
export function createMcpServer(agent) {
  const server = new McpServer({ name: 'bmail', version: '0.1.0' });

  server.tool(
    'whoami',
    'Return your agent ID and public key',
    {},
    async () => ok({ agent_id: agent.id, public_key: agent.public_key, display_name: agent.display_name })
  );

  server.tool(
    'send',
    'Send an encrypted message to another agent by their ID',
    {
      recipient_id: z.string().describe('The recipient agent ID (16-char identifier)'),
      message: z.string().describe('The message content to send'),
    },
    async ({ recipient_id, message }) => {
      if (Buffer.byteLength(message, 'utf8') > 65536) return err('Message exceeds 64KB limit');
      if (recipient_id === agent.id) return err('Cannot send to yourself');

      const recipient = findAgent(recipient_id);
      if (!recipient) return err(`Agent "${recipient_id}" not found`);

      const senderPrivKey = decryptPrivateKey(agent.private_key_enc, process.env.MASTER_KEY);
      const { ciphertext, nonce } = encryptMessage(senderPrivKey, recipient.public_key, message);

      const msgId = storeMessage({
        senderId: agent.id,
        recipientId: recipient_id,
        ciphertext,
        nonce,
      });

      return ok({ message_id: msgId, recipient_id, status: 'sent' });
    }
  );

  server.tool(
    'inbox',
    'List messages in your inbox (metadata only, not decrypted)',
    {},
    async () => {
      const messages = listInbox(agent.id);
      return ok({
        count: messages.length,
        messages: messages.map(m => ({
          id: m.id,
          from: m.sender_id,
          received_at: m.created_at,
          read: !!m.read_at,
        })),
      });
    }
  );

  server.tool(
    'read',
    'Read and decrypt a specific message from your inbox',
    { message_id: z.string().describe('The message ID to read') },
    async ({ message_id }) => {
      const msg = getMessage(message_id, agent.id);
      if (!msg) return err('Message not found');

      const sender = findAgent(msg.sender_id);
      if (!sender) return err('Sender agent no longer exists');

      const recipientPrivKey = decryptPrivateKey(agent.private_key_enc, process.env.MASTER_KEY);
      const plaintext = decryptMessage(recipientPrivKey, sender.public_key, msg.ciphertext, msg.nonce);
      markRead(message_id);

      return ok({
        id: msg.id,
        from: msg.sender_id,
        from_name: sender.display_name,
        message: plaintext,
        received_at: msg.created_at,
      });
    }
  );

  server.tool(
    'delete',
    'Delete a message from your inbox',
    { message_id: z.string().describe('The message ID to delete') },
    async ({ message_id }) => {
      const result = dbDeleteMessage(message_id, agent.id);
      if (result.changes === 0) return err('Message not found');
      return ok({ deleted: message_id });
    }
  );

  return server;
}

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(message) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}
