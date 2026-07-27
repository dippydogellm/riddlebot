import { Markup } from 'telegraf';
import { config } from '../config.js';
import { brand, links } from '../brand.js';

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

export function esc(s) {
  return String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}

export function num(n, dp = 6) {
  if (n == null || Number.isNaN(n)) return '—';
  const v = Number(n);
  if (v === 0) return '0';
  if (Math.abs(v) >= 1000) return v.toLocaleString('en-GB', { maximumFractionDigits: 2 });
  if (Math.abs(v) < 0.000001) return v.toExponential(3);
  return v.toLocaleString('en-GB', { maximumFractionDigits: dp });
}

export function pct(n) {
  if (n == null) return '—';
  const v = Number(n);
  return `${v >= 0 ? '▲' : '▼'} ${Math.abs(v).toFixed(2)}%`;
}

export function short(addr) {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '—';
}

/**
 * Wallet screens print the address, and seed export prints the key itself.
 * In a group that hands every member the funds, so these stay DM-only —
 * the user gets a deep link back into a private chat instead.
 */
export async function requirePrivate(ctx) {
  if (ctx.chat?.type === 'private') return true;

  const username = ctx.botInfo?.username;
  await ctx.reply(
    '🔒 Wallet actions only work in a private chat — a seed posted in a group is a seed everyone owns.',
    username
      ? { reply_markup: { inline_keyboard: [[{ text: '🔒 Continue in private', url: `https://t.me/${username}` }]] } }
      : undefined,
  );
  return false;
}

/**
 * /start sends a photo, and Telegram cannot edit a photo message into text —
 * it answers 400 "there is no text in the message to edit". Every menu opened
 * from that first message hits this, so edits always need a reply fallback.
 */
export async function editOrReply(ctx, text, extra = {}) {
  try {
    return await ctx.editMessageText(text, { parse_mode: 'HTML', ...extra });
  } catch {
    return ctx.replyWithHTML(text, extra);
  }
}

/* ------------------------------------------------------------------ */
/* Keyboards                                                           */
/* ------------------------------------------------------------------ */

export const mainMenu = () => {
  const rows = [
    [Markup.button.callback('💰 Buy Token', 'menu:buy'), Markup.button.callback('💸 Sell Token', 'menu:sell')],
    [Markup.button.callback('🖼 NFTs', 'menu:nft'), Markup.button.callback('📊 Trending', 'menu:trending')],
    [Markup.button.callback('👛 Wallet', 'menu:wallet'), Markup.button.callback('📁 Portfolio', 'menu:portfolio')],
    [Markup.button.callback('🔔 Alerts', 'menu:alerts'), Markup.button.callback('⚙️ Settings', 'menu:settings')],
  ];
  // Telegram rejects an invalid URL button outright, so only add it if set.
  if (/^https?:\/\//.test(brand.site || '')) {
    rows.push([Markup.button.url(`◎ ${brand.suite}`, brand.site)]);
  }
  return Markup.inlineKeyboard(rows);
};

export const backButton = (target = 'menu:main') =>
  Markup.inlineKeyboard([[Markup.button.callback('‹ Back', target)]]);

export const walletMenu = (hasWallet) =>
  Markup.inlineKeyboard(
    hasWallet
      ? [
          [Markup.button.callback('🔄 Refresh balance', 'wallet:refresh')],
          [Markup.button.callback('📤 Withdraw XRP', 'wallet:withdraw')],
          [Markup.button.callback('🔑 Export seed', 'wallet:export')],
          [Markup.button.callback('🗑 Remove wallet', 'wallet:forget')],
          [Markup.button.callback('‹ Back', 'menu:main')],
        ]
      : [
          [Markup.button.callback('✨ Create new wallet', 'wallet:create')],
          [Markup.button.callback('📥 Import existing seed', 'wallet:import')],
          [Markup.button.callback('‹ Back', 'menu:main')],
        ],
  );

const tokenLinksRow = (md5) => {
  const row = [];
  if (md5) row.push(Markup.button.url('💬 Token chat', links.scanner(md5)));
  row.push(Markup.button.url('🔄 Swap', links.swap));
  return row;
};

export const buyKeyboard = (r, md5) => {
  const rows = [];
  const amounts = config.trading.quickBuyXrp;
  for (let i = 0; i < amounts.length; i += 2) {
    rows.push(
      amounts.slice(i, i + 2).map((a) =>
        Markup.button.callback(`Buy ${a} XRP`, `buy:go:${r}:${a}`),
      ),
    );
  }
  rows.push([Markup.button.callback('✏️ Custom amount', `buy:custom:${r}`)]);
  rows.push(tokenLinksRow(md5));
  rows.push([
    Markup.button.callback('🔄 Refresh', `buy:show:${r}`),
    Markup.button.callback('‹ Back', 'menu:main'),
  ]);
  return Markup.inlineKeyboard(rows);
};

export const sellKeyboard = (r, md5) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('25%', `sell:go:${r}:25`),
      Markup.button.callback('50%', `sell:go:${r}:50`),
      Markup.button.callback('100%', `sell:go:${r}:100`),
    ],
    [Markup.button.callback('✏️ Custom amount', `sell:custom:${r}`)],
    tokenLinksRow(md5),
    [Markup.button.callback('‹ Back', 'menu:main')],
  ]);

export const nftMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🔥 Top collections', 'nft:collections')],
    [Markup.button.callback('🎯 Buy by NFTokenID', 'nft:byid')],
    [Markup.button.callback('🖼 My NFTs', 'nft:mine')],
    [Markup.button.callback('‹ Back', 'menu:main')],
  ]);

export const nftActions = (r, canBuy) => {
  const rows = [];
  if (canBuy) rows.push([Markup.button.callback('⚡ Buy floor', `nft:buy:${r}`)]);
  rows.push([
    Markup.button.callback('💵 Place bid', `nft:bid:${r}`),
    Markup.button.callback('🔄 Refresh', `nft:show:${r}`),
  ]);
  rows.push([Markup.button.callback('‹ Back', 'menu:nft')]);
  return Markup.inlineKeyboard(rows);
};

export const settingsMenu = (user) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(`Slippage: ${(user.slippage_bps / 100).toFixed(1)}%`, 'set:slippage')],
    [
      Markup.button.callback(
        `Auto-trustline: ${user.auto_trustline ? 'ON' : 'OFF'}`,
        'set:trustline',
      ),
    ],
    [Markup.button.callback('🌐 My socials', 'set:socials')],
    [Markup.button.callback('‹ Back', 'menu:main')],
  ]);

export const confirmKeyboard = (yes, no = 'menu:main') =>
  Markup.inlineKeyboard([
    [Markup.button.callback('✅ Confirm', yes), Markup.button.callback('✖ Cancel', no)],
  ]);
