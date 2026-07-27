/**
 * Tiny state machine for "reply with a value" prompts. Deliberately in-memory:
 * a restart should drop half-finished trades rather than resume them blindly.
 */
const store = new Map();
const TTL_MS = 10 * 60 * 1000;

export function setState(tgId, state) {
  store.set(tgId, { ...state, at: Date.now() });
}

export function getState(tgId) {
  const s = store.get(tgId);
  if (!s) return null;
  if (Date.now() - s.at > TTL_MS) {
    store.delete(tgId);
    return null;
  }
  return s;
}

export function clearState(tgId) {
  store.delete(tgId);
}

setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, v] of store) if (v.at < cutoff) store.delete(k);
}, 60_000).unref();
