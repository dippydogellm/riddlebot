import { xrpToDrops } from 'xrpl';
import { config } from '../config.js';
import {
  getClient, getXrpBalance, getTrustlines, hasTrustline,
  quoteFromBook, submit, deliveredAmount, assetKey,
} from './xrpl.js';

const XRP = { currency: 'XRP', issuer: null };

/**
 * XRPL swaps are cross-currency payments to yourself. tfPartialPayment lets the
 * ledger deliver less than `Amount` as long as it beats `DeliverMin` — that pair
 * is what actually enforces slippage. Without DeliverMin a partial payment can
 * legally deliver one drop.
 */
const tfPartialPayment = 0x00020000;

function amt(asset, value) {
  return asset.issuer
    ? { currency: asset.currency, issuer: asset.issuer, value: String(value) }
    : xrpToDrops(value.toFixed(6));
}

/* ------------------------------------------------------------------ */

export async function quoteBuy(asset, xrpAmount) {
  const q = await quoteFromBook(XRP, asset, xrpAmount);
  if (!q) throw new Error('Not enough liquidity on the order book for that size.');
  return q;
}

export async function quoteSell(asset, tokenAmount) {
  const q = await quoteFromBook(asset, XRP, tokenAmount);
  if (!q) throw new Error('Not enough XRP-side liquidity to sell that size.');
  return q;
}

/* ------------------------------------------------------------------ */

export async function ensureTrustline(wallet, asset, { limit = '1000000000' } = {}) {
  if (await hasTrustline(wallet.address, asset)) return { created: false };

  const res = await submit(wallet, {
    TransactionType: 'TrustSet',
    Account: wallet.address,
    LimitAmount: { currency: asset.currency, issuer: asset.issuer, value: limit },
  });

  if (!res.ok) throw new Error(`Trustline failed: ${res.code}`);
  return { created: true, hash: res.hash };
}

/**
 * Market buy: spend exactly `xrpAmount` XRP, receive at least
 * quote * (1 - slippage) of the token.
 */
export async function buyToken(wallet, asset, xrpAmount, { slippageBps, autoTrustline = true } = {}) {
  const slip = Math.min(slippageBps ?? config.trading.defaultSlippageBps, config.trading.maxSlippageBps);

  const balance = await getXrpBalance(wallet.address);
  const spendable = balance - config.limits.reserveBufferXrp;
  if (xrpAmount > spendable) {
    throw new Error(`Balance too low. Spendable: ${spendable.toFixed(4)} XRP (${config.limits.reserveBufferXrp} held for reserve).`);
  }

  const quote = await quoteBuy(asset, xrpAmount);
  const minOut = quote.received * (1 - slip / 10000);

  let trustline = { created: false };
  if (autoTrustline) {
    trustline = await ensureTrustline(wallet, asset);
  } else if (!(await hasTrustline(wallet.address, asset))) {
    throw new Error('No trustline set for this token. Enable auto-trustline or set it manually.');
  }

  const res = await submit(wallet, {
    TransactionType: 'Payment',
    Account: wallet.address,
    Destination: wallet.address,
    Amount: amt(asset, quote.received * 1.02), // ceiling; partial payment fills below it
    DeliverMin: amt(asset, minOut),
    SendMax: xrpToDrops(xrpAmount.toFixed(6)),
    Flags: tfPartialPayment,
  });

  if (!res.ok) {
    const hint = res.code === 'tecPATH_PARTIAL'
      ? 'Price moved past your slippage. Raise slippage or reduce size.'
      : res.code === 'tecPATH_DRY'
        ? 'No route to that token right now.'
        : res.code;
    throw new Error(`Buy failed: ${hint}`);
  }

  const filled = deliveredAmount(res.meta);
  await chargeFee(wallet, xrpAmount).catch((e) => console.warn('[fee]', e.message));

  return {
    ...res,
    filled,
    spent: xrpAmount,
    price: filled ? xrpAmount / filled : null,
    trustlineCreated: trustline.created,
    asset: assetKey(asset),
  };
}

/** Market sell: give up `tokenAmount`, receive XRP. Pass 'max' to dump the lot. */
export async function sellToken(wallet, asset, tokenAmount, { slippageBps } = {}) {
  const slip = Math.min(slippageBps ?? config.trading.defaultSlippageBps, config.trading.maxSlippageBps);

  if (tokenAmount === 'max') {
    const lines = await getTrustlines(wallet.address);
    const line = lines.find((l) => l.currency === asset.currency && l.issuer === asset.issuer);
    if (!line || line.balance <= 0) throw new Error('You hold none of that token.');
    tokenAmount = line.balance;
  }

  const quote = await quoteSell(asset, tokenAmount);
  const minOut = quote.received * (1 - slip / 10000);

  const res = await submit(wallet, {
    TransactionType: 'Payment',
    Account: wallet.address,
    Destination: wallet.address,
    Amount: xrpToDrops((quote.received * 1.02).toFixed(6)),
    DeliverMin: xrpToDrops(minOut.toFixed(6)),
    SendMax: amt(asset, tokenAmount),
    Flags: tfPartialPayment,
  });

  if (!res.ok) throw new Error(`Sell failed: ${res.code}`);

  const filled = deliveredAmount(res.meta);
  await chargeFee(wallet, filled ?? 0).catch((e) => console.warn('[fee]', e.message));

  return { ...res, filled, sold: tokenAmount, asset: assetKey(asset) };
}

/** Removes a zero-balance trustline and reclaims the 0.2 XRP owner reserve. */
export async function closeTrustline(wallet, asset) {
  const res = await submit(wallet, {
    TransactionType: 'TrustSet',
    Account: wallet.address,
    LimitAmount: { currency: asset.currency, issuer: asset.issuer, value: '0' },
    Flags: 0x00040000, // tfClearNoRipple
  });
  if (!res.ok) throw new Error(`Could not close trustline: ${res.code}`);
  return res;
}

/* ------------------------------------------------------------------ */

async function chargeFee(wallet, xrpVolume) {
  const { feeBps, feeWallet } = config.trading;
  if (!feeWallet || !feeBps) return null;

  const fee = xrpVolume * (feeBps / 10000);
  if (fee < 0.001) return null; // below dust, not worth a tx fee

  return submit(wallet, {
    TransactionType: 'Payment',
    Account: wallet.address,
    Destination: feeWallet,
    Amount: xrpToDrops(fee.toFixed(6)),
  });
}
