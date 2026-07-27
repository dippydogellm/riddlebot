import { Wallet } from 'xrpl';
import { q } from './db.js';
import { encryptSeed, decryptSeed } from './crypto.js';

export function createWallet(tgId) {
  const w = Wallet.generate();
  q.setWallet.run(w.address, encryptSeed(w.seed, tgId), tgId);
  return w;
}

export function importWallet(tgId, seedOrKey) {
  const trimmed = seedOrKey.trim();
  let w;
  try {
    w = trimmed.startsWith('s') ? Wallet.fromSeed(trimmed) : Wallet.fromSecret(trimmed);
  } catch {
    throw new Error('That does not look like a valid family seed (starts with "s").');
  }
  q.setWallet.run(w.address, encryptSeed(w.seed, tgId), tgId);
  return w;
}

/** Decrypts on demand — the seed never lives in memory longer than a trade. */
export function loadWallet(tgId) {
  const user = q.getUser.get(tgId);
  if (!user?.seed_enc) return null;
  return Wallet.fromSeed(decryptSeed(user.seed_enc, tgId));
}

export function requireWallet(tgId) {
  const w = loadWallet(tgId);
  if (!w) throw new Error('No wallet yet. Use /wallet to create or import one.');
  return w;
}

export function exportSeed(tgId) {
  const user = q.getUser.get(tgId);
  if (!user?.seed_enc) throw new Error('No wallet stored.');
  return decryptSeed(user.seed_enc, tgId);
}

export function forgetWallet(tgId) {
  q.clearWallet.run(tgId);
}
