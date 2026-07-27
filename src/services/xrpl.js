import { Client, Wallet, dropsToXrp, xrpToDrops, convertStringToHex, convertHexToString } from 'xrpl';
import { config } from '../config.js';

let client;
let connecting;

export async function getClient() {
  if (client?.isConnected()) return client;
  if (connecting) return connecting;

  connecting = (async () => {
    client = new Client(config.xrpl.wsUrl, { connectionTimeout: 15000 });
    client.on('disconnected', () => { client = null; connecting = null; });
    await client.connect();
    connecting = null;
    return client;
  })();

  return connecting;
}

export { Wallet, dropsToXrp, xrpToDrops };

/* ------------------------------------------------------------------ */
/* Currency code handling                                              */
/* ------------------------------------------------------------------ */

/** XRPL uses 3-char ASCII codes, or 40-char hex for anything longer. */
export function toCurrencyCode(code) {
  if (!code) throw new Error('Empty currency code');
  if (code.length === 3) return code;
  if (/^[0-9A-F]{40}$/i.test(code)) return code.toUpperCase();
  return convertStringToHex(code).padEnd(40, '0').toUpperCase();
}

export function fromCurrencyCode(code) {
  if (!code) return '';
  if (code.length === 3) return code;
  try {
    return convertHexToString(code).replace(/\0+$/, '') || code;
  } catch {
    return code;
  }
}

/** "SOLO.rsoLo2S..." or "SOLO:rsoLo2S..." -> { currency, issuer } */
export function parseAsset(input) {
  const raw = String(input).trim();
  if (raw.toUpperCase() === 'XRP') return { currency: 'XRP', issuer: null };

  const sep = raw.includes(':') ? ':' : raw.includes('.') ? '.' : null;
  if (!sep) throw new Error('Use CODE.issuer format, e.g. SOLO.rsoLo2S...');

  const idx = raw.lastIndexOf(sep);
  const code = raw.slice(0, idx);
  const issuer = raw.slice(idx + 1);
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(issuer)) throw new Error('Invalid issuer address');
  return { currency: toCurrencyCode(code), issuer, label: fromCurrencyCode(toCurrencyCode(code)) };
}

export function assetKey(a) {
  return a.issuer ? `${fromCurrencyCode(a.currency)}.${a.issuer}` : 'XRP';
}

/* ------------------------------------------------------------------ */
/* Account reads                                                       */
/* ------------------------------------------------------------------ */

export async function getXrpBalance(address) {
  const c = await getClient();
  try {
    const res = await c.request({ command: 'account_info', account: address, ledger_index: 'validated' });
    return Number(dropsToXrp(res.result.account_data.Balance));
  } catch (e) {
    if (String(e.data?.error) === 'actNotFound') return 0;
    throw e;
  }
}

export async function getTrustlines(address) {
  const c = await getClient();
  try {
    const res = await c.request({ command: 'account_lines', account: address, limit: 400, ledger_index: 'validated' });
    return res.result.lines.map((l) => ({
      currency: l.currency,
      label: fromCurrencyCode(l.currency),
      issuer: l.account,
      balance: Number(l.balance),
      limit: Number(l.limit),
    }));
  } catch (e) {
    if (String(e.data?.error) === 'actNotFound') return [];
    throw e;
  }
}

export async function hasTrustline(address, asset) {
  const lines = await getTrustlines(address);
  return lines.some((l) => l.currency === asset.currency && l.issuer === asset.issuer);
}

export async function getAccountNfts(address) {
  const c = await getClient();
  const out = [];
  let marker;
  try {
    do {
      const res = await c.request({ command: 'account_nfts', account: address, limit: 100, marker });
      out.push(...res.result.account_nfts);
      marker = res.result.marker;
    } while (marker && out.length < 400);
  } catch (e) {
    if (String(e.data?.error) === 'actNotFound') return [];
    throw e;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Order book pricing                                                  */
/* ------------------------------------------------------------------ */

function amountSpec(asset) {
  return asset.issuer ? { currency: asset.currency, issuer: asset.issuer } : { currency: 'XRP' };
}

/**
 * Walks the live order book and returns how much of `takerGets` you receive
 * for `payAmount` of `takerPays`. Returns null if the book is too thin.
 */
export async function quoteFromBook(payAsset, getAsset, payAmount) {
  const c = await getClient();
  const res = await c.request({
    command: 'book_offers',
    taker_gets: amountSpec(getAsset),
    taker_pays: amountSpec(payAsset),
    limit: 200,
    ledger_index: 'validated',
  });

  const offers = res.result.offers || [];
  let remaining = payAmount;
  let received = 0;

  for (const o of offers) {
    const gets = typeof o.TakerGets === 'string' ? Number(dropsToXrp(o.TakerGets)) : Number(o.TakerGets.value);
    const pays = typeof o.TakerPays === 'string' ? Number(dropsToXrp(o.TakerPays)) : Number(o.TakerPays.value);
    if (!gets || !pays) continue;

    const take = Math.min(remaining, pays);
    received += (take / pays) * gets;
    remaining -= take;
    if (remaining <= 1e-12) break;
  }

  if (remaining > payAmount * 0.001) return null; // book couldn't fill it
  return { received, avgPrice: payAmount / received, depth: offers.length };
}

/* ------------------------------------------------------------------ */
/* Submission                                                          */
/* ------------------------------------------------------------------ */

/**
 * One in-flight transaction per address, always.
 *
 * autofill() reads the account sequence from the ledger. Fire two submissions
 * concurrently from the same wallet and both get the same sequence — the second
 * dies with tefPAST_SEQ. Copy trading makes that a certainty rather than a race,
 * since one leader trade can fan out to several of a follower's own txs.
 */
const queues = new Map();

function serialise(address, fn) {
  const prev = queues.get(address) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // Keep the chain alive on failure, and drop it once idle.
  queues.set(address, next.catch(() => {}));
  next.finally(() => {
    if (queues.get(address) === next || queues.get(address)?.__from === next) queues.delete(address);
  }).catch(() => {});
  return next;
}

export async function submit(wallet, tx) {
  return serialise(wallet.address, async () => {
    const c = await getClient();
    const prepared = await c.autofill(tx);
    const signed = wallet.sign(prepared);
    const res = await c.submitAndWait(signed.tx_blob);

    const code = res.result.meta?.TransactionResult;
    return {
      ok: code === 'tesSUCCESS',
      code,
      hash: res.result.hash,
      meta: res.result.meta,
      explorer: `https://livenet.xrpl.org/transactions/${res.result.hash}`,
    };
  });
}

/** Sums what the account actually received from a transaction's metadata. */
export function deliveredAmount(meta) {
  const d = meta?.delivered_amount ?? meta?.DeliveredAmount;
  if (!d) return null;
  return typeof d === 'string' ? Number(dropsToXrp(d)) : Number(d.value);
}
