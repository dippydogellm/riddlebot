import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getSettings } from './services/edgeConfig.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const brand = {
  name: 'Riddle Buy Bot',
  suite: 'Riddle Labs',
  tagline: 'Every XRPL token and NFT, one tap away.',
  site: process.env.BRAND_SITE || 'https://riddlelabs.io',
  support: process.env.BRAND_SUPPORT || null, // e.g. '@riddlelabs'

  logo: path.join(root, 'assets', 'rdl-logo.jpg'),

  // Matches the black/cream Riddle Labs system used across the web products.
  colours: {
    ink: '#0A0A0A',
    cream: '#F4F0E6',
    accent: '#FFFFFF',
  },
};

const explorerBase = () =>
  (process.env.XRPL_NETWORK || 'mainnet') === 'mainnet'
    ? 'https://livenet.xrpl.org'
    : 'https://testnet.xrpl.org';

export const links = {
  swap: 'https://swap.riddlewallet.com/',
  // xrpl.to-style md5(currency+issuer) id — same field the bot already reads off `api.token()`.
  // Route shapes taken from the scanner bundle's own link builders — it
  // lowercases the md5, and has no per-NFT page, only /collection/<slug>.
  scanner: (md5) => `https://scanner.riddlewallet.com/token/${String(md5).toLowerCase()}`,
  trending: 'https://scanner.riddlewallet.com/',
  collection: (slug) => `https://scanner.riddlewallet.com/collection/${encodeURIComponent(slug)}`,
  nft: (nftokenId) => `${explorerBase()}/nft/${nftokenId}`,
  tx: (hash) => `${explorerBase()}/transactions/${hash}`,
  account: (address) => `${explorerBase()}/accounts/${address}`,
};

export const footer = () => {
  const linked = /^https?:\/\//.test(brand.site || '');
  return `<i>${brand.suite}</i>${linked ? ` · <a href="${brand.site}">${brand.site.replace(/^https?:\/\//, '')}</a>` : ''}`;
};

const escHtml = (s) =>
  String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/** The sellable ad slot, set from the admin panel. Empty string when unset. */
export async function adFooter() {
  const { ad_text: text, ad_url: url } = await getSettings();
  if (!text || !url) return '';

  // A quote or space slipping into href would make Telegram reject the whole
  // message ("can't parse entities"), which would break every card that renders
  // this footer — so parse strictly and re-serialise rather than trusting input.
  let href;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    href = parsed.href;
  } catch {
    return '';
  }

  return `\n\n<a href="${escHtml(href)}">${escHtml(text)}</a>`;
}

/**
 * Telegram re-uploads a file on every send unless you hand back a file_id.
 * Cache the first one and every later /start is a reference, not an upload.
 */
let cachedFileId = null;

export async function sendLogo(ctx, caption, extra = {}) {
  const opts = { caption, parse_mode: 'HTML', ...extra };

  if (cachedFileId) {
    try {
      return await ctx.replyWithPhoto(cachedFileId, opts);
    } catch {
      cachedFileId = null; // file_ids can go stale; fall through to a re-upload
    }
  }

  if (!fs.existsSync(brand.logo)) {
    return ctx.replyWithHTML(caption, extra); // asset missing — text still works
  }

  const msg = await ctx.replyWithPhoto({ source: brand.logo }, opts);
  cachedFileId = msg.photo?.[msg.photo.length - 1]?.file_id ?? null;
  return msg;
}
