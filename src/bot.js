import { Telegraf } from 'telegraf';
import { config } from './config.js';
import { brand } from './brand.js';
import { ensureUser } from './services/db.js';
import { getState } from './services/session.js';
import { registerWallet } from './handlers/wallet.js';
import { registerTokens } from './handlers/tokens.js';
import { registerNfts } from './handlers/nfts.js';
import { registerSettings } from './handlers/settings.js';

/**
 * Builds the bot without launching it, so the same wiring serves both entry
 * points: src/index.js (long-running polling — the real deployment) and
 * api/webhook.js (serverless webhook — limited, see DEPLOY.md).
 */
export function buildBot() {
  const bot = new Telegraf(config.botToken, { handlerTimeout: 120_000 });

  /**
   * The bot is DM-only. Groups get exactly one capability: an admin pointing
   * the buy-bot feed at a token or collection. Everything else — wallets,
   * trading, menus — stays in a private chat, so nothing that touches funds
   * or reveals a balance can happen in front of an audience.
   *
   * This runs before any handler is registered, so it covers every command,
   * button and message rather than relying on per-handler guards.
   */
  const GROUP_ALLOWED = /^\/(settokenbot|setnftbot|stoptokenbot)(@\w+)?\b/i;

  bot.use(async (ctx, next) => {
    const type = ctx.chat?.type;
    if (!type || type === 'private') return next();

    if (GROUP_ALLOWED.test(ctx.message?.text || '')) return next();

    // Buttons on alerts posted into a group: send the person to a DM.
    if (ctx.callbackQuery) {
      const username = ctx.botInfo?.username;
      await ctx.answerCbQuery(
        username ? 'Open me in private to trade.' : 'Trading only works in a private chat.',
        { url: username ? `https://t.me/${username}` : undefined },
      ).catch(() => {});
      return;
    }

    // Otherwise stay silent. Only speak when explicitly addressed —
    // /command@thisbot — so the bot never talks over a group unprompted.
    const text = ctx.message?.text || '';
    const username = ctx.botInfo?.username;
    const addressed = username && new RegExp(`^/\\w+@${username}\\b`, 'i').test(text);
    if (!addressed) return;

    await ctx.reply(
      'I only work in a private chat. In a group I can post buys — an admin can set that up with /settokenbot.',
      { reply_markup: { inline_keyboard: [[{ text: '🔒 Open in private', url: `https://t.me/${username}` }]] } },
    ).catch(() => {});
  });

  const wallet = registerWallet(bot);
  const tokens = registerTokens(bot);
  const nfts = registerNfts(bot);
  const settings = registerSettings(bot);

  bot.on('text', async (ctx) => {
    ensureUser(ctx);
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    const state = getState(ctx.from.id);
    if (state) {
      for (const mod of [wallet, tokens, nfts, settings]) {
        if (await mod.handleText(ctx, state)) return;
      }
    }

    if (nfts.isNftId(text)) return nfts.showNft(ctx, text.toUpperCase());
    if (text.includes('.') || text.includes(':')) return tokens.showBuy(ctx, text);

    await ctx.reply('Paste a CODE.issuer token pair or an NFTokenID, or use /menu.');
  });

  bot.catch(async (err, ctx) => {
    console.error('[bot]', err);
    try { await ctx.reply('Something broke on my end. Try again in a moment.'); } catch { /* chat gone */ }
  });

  return bot;
}

export const COMMANDS = [
  { command: 'start', description: 'Open the bot' },
  { command: 'menu', description: 'Main menu' },
  { command: 'wallet', description: 'Wallet and balance' },
  { command: 'history', description: 'Recent trades' },
  { command: 'settokenbot', description: 'Post token buys in this chat' },
  { command: 'setnftbot', description: 'Post NFT collection sales in this chat' },
  { command: 'stoptokenbot', description: 'Stop posting buys here' },
  { command: 'about', description: `About ${brand.name}` },
];
