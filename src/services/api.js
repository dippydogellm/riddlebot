import { config } from '../config.js';

async function call(path, params = {}, { method = 'GET', body = null } = {}) {
  const url = new URL(config.api.base + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }

  // Cloudflare fronts xrpl.to and 403s Node's default fetch User-Agent, which
  // made every market-data call fail silently. Identify ourselves explicitly.
  const headers = {
    accept: 'application/json',
    'user-agent': 'RiddleBot/1.0 (+https://riddlelabs.io)',
  };
  if (config.api.key) headers['x-api-key'] = config.api.key;
  if (body) headers['content-type'] = 'application/json';

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), config.api.timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`xrpl.to ${res.status} on ${path}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/* Market data ------------------------------------------------------- */

export const api = {
  /** Top tokens. sort: volume | marketcap | pro24h */
  tokens: (limit = 20, sort = 'volume') => call('/tokens', { limit, sort, order: 'desc' }),

  /** Free-text search across tokens by name / code / issuer. POST, not GET. */
  search: (query, limit = 10) =>
    call('/search', {}, { method: 'POST', body: { search: query, limit } }),

  /** Full detail for one token by its md5 id or `issuer-currencyHex` slug. */
  token: (id) => call(`/token/${encodeURIComponent(id)}`),

  /** 0-100 rug/risk score. Takes the md5 id only (not the slug). */
  review: (md5) => call(`/token/review/${encodeURIComponent(md5)}`),

  /** OHLC candles for charts / alerts. */
  ohlc: (id, range = '1D') => call(`/ohlc/${encodeURIComponent(id)}`, { range }),

  /** Account holdings, enriched with USD values. */
  trustlines: (address) => call(`/account/trustlines/${address}`),
  balance: (address) => call(`/account/balance/${address}`),
  accountNfts: (address, limit = 50) => call(`/account/nfts/${address}`, { limit }),

  /** NFT collections and listings. */
  collections: (limit = 20) => call('/nft/collections', { limit, sort: 'volume', order: 'desc' }),
  collection: (slug) => call(`/nft/collections/${encodeURIComponent(slug)}`),
  collectionNfts: (slug, limit = 12, page = 0) =>
    call(`/nft/collections/${encodeURIComponent(slug)}/nfts`, {
      limit,
      offset: page * limit,
      listed: 'xrp', // XRP-denominated listings only — the bot can't fill the rest
      sort: 'price-low',
    }),
  nft: (nftokenId) => call(`/nft/${nftokenId}`),
};

/** Never let a data-provider hiccup kill a command. */
export async function safe(promise, fallback = null) {
  try {
    return await promise;
  } catch (e) {
    console.warn('[api]', e.message);
    return fallback;
  }
}
