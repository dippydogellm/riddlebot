/**
 * Telegram caps callback_data at 64 bytes. A 64-char NFTokenID plus a prefix
 * blows straight through that, and issuer addresses get close. So buttons carry
 * a short handle and we resolve it here.
 *
 * Handles are content-addressed, so the same asset always yields the same key —
 * a refresh button minted an hour ago still resolves after new entries arrive.
 */
import crypto from 'node:crypto';

const byKey = new Map();
const MAX = 20_000;

export function ref(value) {
  const key = crypto.createHash('sha1').update(String(value)).digest('base64url').slice(0, 10);
  byKey.set(key, { value: String(value), at: Date.now() });

  if (byKey.size > MAX) {
    // Drop the oldest quarter rather than churning on every insert.
    const sorted = [...byKey.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [k] of sorted.slice(0, MAX / 4)) byKey.delete(k);
  }
  return key;
}

export function deref(key) {
  const hit = byKey.get(key);
  if (!hit) return null;
  hit.at = Date.now(); // touch, so active assets survive eviction
  return hit.value;
}

/** Throws a user-facing message rather than a null deref deep in a handler. */
export function derefOrThrow(key) {
  const v = deref(key);
  if (!v) throw new Error('That button has expired. Open the asset again from the menu.');
  return v;
}
