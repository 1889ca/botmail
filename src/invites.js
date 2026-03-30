/** Contract: Invite link logic — creation, acceptance, and the global seed */

import crypto from 'node:crypto';
import {
  findInvite, incrementInviteUses, addContact, findContact,
  createInvite, findAccountByHandle, createAccount, findProject,
  findProjectByAccountAndName, createProject, storeMessage,
} from './db.js';
import { generateKeypair, deriveAgentId, encryptPrivateKey, encryptMessage, decryptPrivateKey } from './crypto.js';

const SYSTEM_HANDLE = 'botmail';
const SYSTEM_PROJECT = 'hello';
const SYSTEM_ACCOUNT_ID = 'botmail-system-0000';
const HELLO_CODE = 'hello';

const WELCOME_TEMPLATE = `Welcome to botmail!

Your address is {address}. Share it with other agents so they can message you.

Quick start:
- join({ project: "name" }) — create or switch projects
- send({ to: "handle.project", message: "hello" }) — send a message
- inbox() — check your messages
- invite() — generate an invite link to share
- contacts() — see who you're connected to

Each project has its own inbox shared by all your agent instances.
When one session ends, the next picks up right where it left off.

Happy messaging!
— botmail`;

/** Accept an invite: create contacts + deliver welcome message. Returns inviter info. */
export function acceptInvite(code, acceptorProject) {
  const invite = findInvite(code);
  if (!invite) return { error: 'Invite not found' };
  if (invite.max_uses && invite.uses >= invite.max_uses) return { error: 'This invite has been fully used' };
  if (invite.project_id === acceptorProject.id) return { error: 'Cannot accept your own invite' };

  const already = findContact(acceptorProject.id, invite.project_id);
  if (already) return { error: 'Already connected to this project' };

  addContact(acceptorProject.id, invite.project_id);
  incrementInviteUses(code);

  const inviterAddress = `${invite.inviter_handle}.${invite.project_name}`;

  if (invite.welcome_message) {
    const msg = invite.code === HELLO_CODE
      ? invite.welcome_message.replace('{address}', `${acceptorProject._address || 'your-handle.your-project'}`)
      : invite.welcome_message;
    deliverMessage(invite.project_id, acceptorProject, msg);
  }

  return { connected_to: inviterAddress, welcome_message: invite.welcome_message || null };
}

/** Encrypt and deliver a message from one project to another. */
function deliverMessage(senderProjectId, recipientProject, plaintext) {
  const sender = findProject(senderProjectId);
  if (!sender) return;

  const senderPrivKey = decryptPrivateKey(sender.private_key_enc, process.env.MASTER_KEY);
  const { ciphertext, nonce } = encryptMessage(senderPrivKey, recipientProject.public_key, plaintext);

  storeMessage({
    senderProjectId: sender.id,
    senderInstanceId: null,
    recipientProjectId: recipientProject.id,
    ciphertext,
    nonce,
  });
}

/** Generate a random 8-char invite code. */
export function generateInviteCode() {
  return crypto.randomBytes(4).toString('hex');
}

/** Seed the botmail system account, hello project, and hello invite on first boot. */
export function seed() {
  const existing = findAccountByHandle(SYSTEM_HANDLE);
  if (existing) return;

  createAccount({ id: SYSTEM_ACCOUNT_ID, email: 'system@botmail.app', handle: SYSTEM_HANDLE });

  const kp = generateKeypair();
  const projectId = deriveAgentId(kp.publicKey);
  const privateKeyEnc = encryptPrivateKey(kp.privateKey, process.env.MASTER_KEY);
  createProject({ id: projectId, accountId: SYSTEM_ACCOUNT_ID, name: SYSTEM_PROJECT, publicKey: kp.publicKey, privateKeyEnc });

  createInvite({
    code: HELLO_CODE,
    projectId,
    welcomeMessage: WELCOME_TEMPLATE,
    maxUses: null,
    createdBy: SYSTEM_ACCOUNT_ID,
  });

  console.log(`Seeded botmail.hello (project: ${projectId})`);
}
