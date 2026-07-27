/**
 * Reads admin-editable settings (currently just the sellable ad-footer link)
 * out of Vercel Edge Config. This exists because Vercel serverless functions
 * don't share a local disk — the SQLite file each function sees can differ
 * between invocations, so anything the admin panel needs to change and have
 * the bot see immediately has to live somewhere both sides actually share.
 *
 * Falls back to empty values when the env vars aren't set (e.g. local dev),
 * so nothing breaks off-Vercel.
 */

let cache = null;
let cacheAt = 0;
const CACHE_MS = 30_000;

export async function getSettings() {
  const id = process.env.EDGE_CONFIG_ID;
  const token = process.env.EDGE_CONFIG_READ_TOKEN;
  if (!id || !token) return {};

  if (cache && Date.now() - cacheAt < CACHE_MS) return cache;

  try {
    const res = await fetch(`https://edge-config.vercel.com/${id}/items?token=${token}`);
    if (!res.ok) return cache || {};
    cache = await res.json();
    cacheAt = Date.now();
    return cache;
  } catch {
    return cache || {};
  }
}
