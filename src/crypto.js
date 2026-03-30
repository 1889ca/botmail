/** Contract: Encryption primitives using tweetnacl (X25519 + XSalsa20-Poly1305) */

import nacl from 'tweetnacl';
import util from 'tweetnacl-util';
import crypto from 'node:crypto';

const { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } = util;

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function toBase58(bytes) {
  let num = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  let out = '';
  while (num > 0n) {
    out = BASE58[Number(num % 58n)] + out;
    num /= 58n;
  }
  return out || '1';
}

/** No async init needed — tweetnacl is pure JS. */
export async function init() {}

/** Generate an X25519 keypair for encryption. */
export function generateKeypair() {
  const kp = nacl.box.keyPair();
  return {
    publicKey: encodeBase64(kp.publicKey),
    privateKey: encodeBase64(kp.secretKey),
  };
}

/** Derive a 16-char agent ID from a public key. */
export function deriveAgentId(publicKeyB64) {
  const hash = crypto.createHash('sha256').update(decodeBase64(publicKeyB64)).digest();
  return toBase58(hash).slice(0, 16);
}

/** Encrypt a message from sender to recipient using NaCl box. */
export function encryptMessage(senderPrivKeyB64, recipientPubKeyB64, plaintext) {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const messageBytes = decodeUTF8(plaintext);
  const cipher = nacl.box(
    messageBytes,
    nonce,
    decodeBase64(recipientPubKeyB64),
    decodeBase64(senderPrivKeyB64)
  );
  return {
    ciphertext: encodeBase64(cipher),
    nonce: encodeBase64(nonce),
  };
}

/** Decrypt a message sent to recipient from sender. */
export function decryptMessage(recipientPrivKeyB64, senderPubKeyB64, ciphertextB64, nonceB64) {
  const plain = nacl.box.open(
    decodeBase64(ciphertextB64),
    decodeBase64(nonceB64),
    decodeBase64(senderPubKeyB64),
    decodeBase64(recipientPrivKeyB64)
  );
  if (!plain) throw new Error('Decryption failed — message may be tampered');
  return encodeUTF8(plain);
}

/** Encrypt a private key for storage using the server master key (NaCl secretbox). */
export function encryptPrivateKey(privKeyB64, masterKeyHex) {
  const key = Buffer.from(masterKeyHex, 'hex');
  if (key.length !== nacl.secretbox.keyLength) {
    throw new Error(`MASTER_KEY must be ${nacl.secretbox.keyLength} bytes (${nacl.secretbox.keyLength * 2} hex chars)`);
  }
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const cipher = nacl.secretbox(decodeBase64(privKeyB64), nonce, key);
  return encodeBase64(nonce) + ':' + encodeBase64(cipher);
}

/** Decrypt a stored private key using the server master key. */
export function decryptPrivateKey(encrypted, masterKeyHex) {
  const [nonceB64, cipherB64] = encrypted.split(':');
  const key = Buffer.from(masterKeyHex, 'hex');
  const plain = nacl.secretbox.open(decodeBase64(cipherB64), decodeBase64(nonceB64), key);
  if (!plain) throw new Error('Private key decryption failed — wrong MASTER_KEY?');
  return encodeBase64(plain);
}
