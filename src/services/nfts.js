import { xrpToDrops, dropsToXrp, convertHexToString } from 'xrpl';
import { getClient, submit, getXrpBalance } from './xrpl.js';
import { config } from '../config.js';

const tfSellNFToken = 0x00000001;

/* ------------------------------------------------------------------ */
/* Reading offers                                                      */
/* ------------------------------------------------------------------ */

function normaliseOffer(o) {
  const isXrp = typeof o.amount === 'string';
  return {
    index: o.nft_offer_index,
    owner: o.owner,
    destination: o.destination || null,
    expiration: o.expiration || null,
    isXrp,
    price: isXrp ? Number(dropsToXrp(o.amount)) : Number(o.amount.value),
    currency: isXrp ? 'XRP' : o.amount.currency,
    issuer: isXrp ? null : o.amount.issuer,
  };
}

/** Live sell offers (asks) for one NFT, cheapest first. */
export async function getSellOffers(nftokenId) {
  const c = await getClient();
  try {
    const res = await c.request({ command: 'nft_sell_offers', nft_id: nftokenId, limit: 50 });
    return (res.result.offers || [])
      .map(normaliseOffer)
      .filter((o) => !o.expiration || o.expiration * 1000 + 946684800000 > Date.now())
      .sort((a, b) => a.price - b.price);
  } catch (e) {
    if (String(e.data?.error) === 'objectNotFound') return [];
    throw e;
  }
}

/** Live buy offers (bids) for one NFT, highest first. */
export async function getBuyOffers(nftokenId) {
  const c = await getClient();
  try {
    const res = await c.request({ command: 'nft_buy_offers', nft_id: nftokenId, limit: 50 });
    return (res.result.offers || []).map(normaliseOffer).sort((a, b) => b.price - a.price);
  } catch (e) {
    if (String(e.data?.error) === 'objectNotFound') return [];
    throw e;
  }
}

export function decodeUri(hexUri) {
  if (!hexUri) return null;
  try {
    const s = convertHexToString(hexUri);
    return s.startsWith('ipfs://') ? s.replace('ipfs://', 'https://ipfs.io/ipfs/') : s;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Buying                                                              */
/* ------------------------------------------------------------------ */

/**
 * Sweeps the floor: takes the cheapest open sell offer, provided it's public
 * (no Destination lock) and inside maxPriceXrp.
 */
export async function buyNftFloor(wallet, nftokenId, { maxPriceXrp } = {}) {
  const offers = await getSellOffers(nftokenId);
  if (!offers.length) throw new Error('That NFT has no open sell offers.');

  const open = offers.filter(
    (o) => o.isXrp && (!o.destination || o.destination === wallet.address),
  );
  if (!open.length) throw new Error('The only listings are private or priced in tokens.');

  const best = open[0];
  if (maxPriceXrp != null && best.price > maxPriceXrp) {
    throw new Error(`Floor is ${best.price} XRP, above your ${maxPriceXrp} XRP limit.`);
  }

  const balance = await getXrpBalance(wallet.address);
  if (best.price > balance - config.limits.reserveBufferXrp) {
    throw new Error(`Need ${best.price} XRP plus reserve. You have ${balance.toFixed(4)}.`);
  }

  return acceptSellOffer(wallet, best.index, best.price, nftokenId);
}

export async function acceptSellOffer(wallet, offerIndex, price, nftokenId) {
  const res = await submit(wallet, {
    TransactionType: 'NFTokenAcceptOffer',
    Account: wallet.address,
    NFTokenSellOffer: offerIndex,
  });

  if (!res.ok) {
    const hint = res.code === 'tecOBJECT_NOT_FOUND'
      ? 'That listing was taken or cancelled a moment ago.'
      : res.code === 'tecINSUFFICIENT_FUNDS'
        ? 'Not enough XRP once reserves are counted.'
        : res.code;
    throw new Error(`NFT buy failed: ${hint}`);
  }

  await chargeFee(wallet, price).catch((e) => console.warn('[fee]', e.message));
  return { ...res, price, nftokenId };
}

/** Places a bid that the holder can accept later. Locks 0.2 XRP owner reserve. */
export async function makeBid(wallet, nftokenId, owner, priceXrp, { expiryHours } = {}) {
  const tx = {
    TransactionType: 'NFTokenCreateOffer',
    Account: wallet.address,
    NFTokenID: nftokenId,
    Owner: owner,
    Amount: xrpToDrops(Number(priceXrp).toFixed(6)),
  };

  if (expiryHours) {
    // XRPL ripple-epoch = unix seconds - 946684800
    tx.Expiration = Math.floor(Date.now() / 1000) + expiryHours * 3600 - 946684800;
  }

  const res = await submit(wallet, tx);
  if (!res.ok) throw new Error(`Bid failed: ${res.code}`);
  return res;
}

/* ------------------------------------------------------------------ */
/* Selling                                                             */
/* ------------------------------------------------------------------ */

export async function listNft(wallet, nftokenId, priceXrp, { destination } = {}) {
  const tx = {
    TransactionType: 'NFTokenCreateOffer',
    Account: wallet.address,
    NFTokenID: nftokenId,
    Amount: xrpToDrops(Number(priceXrp).toFixed(6)),
    Flags: tfSellNFToken,
  };
  if (destination) tx.Destination = destination;

  const res = await submit(wallet, tx);
  if (!res.ok) throw new Error(`Listing failed: ${res.code}`);
  return res;
}

export async function acceptBid(wallet, offerIndex) {
  const res = await submit(wallet, {
    TransactionType: 'NFTokenAcceptOffer',
    Account: wallet.address,
    NFTokenBuyOffer: offerIndex,
  });
  if (!res.ok) throw new Error(`Accept failed: ${res.code}`);
  return res;
}

export async function cancelOffer(wallet, offerIndex) {
  const res = await submit(wallet, {
    TransactionType: 'NFTokenCancelOffer',
    Account: wallet.address,
    NFTokenOffers: [offerIndex],
  });
  if (!res.ok) throw new Error(`Cancel failed: ${res.code}`);
  return res;
}

/* ------------------------------------------------------------------ */

async function chargeFee(wallet, xrpVolume) {
  const { feeBps, feeWallet } = config.trading;
  if (!feeWallet || !feeBps) return null;
  const fee = xrpVolume * (feeBps / 10000);
  if (fee < 0.001) return null;

  return submit(wallet, {
    TransactionType: 'Payment',
    Account: wallet.address,
    Destination: feeWallet,
    Amount: xrpToDrops(fee.toFixed(6)),
  });
}
