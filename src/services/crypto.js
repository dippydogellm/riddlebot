import crypto from 'node:crypto';
import { config } from '../config.js';

const ALGO = 'aes-256-gcm';

/**
 * Per-record salt + scrypt means two identical seeds never produce identical
 * ciphertext, and a leaked DB is useless without MASTER_KEY.
 */
export function encryptSeed(seed, userId) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(config.masterKey, Buffer.concat([salt, Buffer.from(String(userId))]), 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(seed, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [salt, iv, tag, enc].map((b) => b.toString('base64')).join('.');
}

export function decryptSeed(payload, userId) {
  const [salt, iv, tag, enc] = payload.split('.').map((s) => Buffer.from(s, 'base64'));
  const key = crypto.scryptSync(config.masterKey, Buffer.concat([salt, Buffer.from(String(userId))]), 32);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
