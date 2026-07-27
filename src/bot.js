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
  { command: 'about', description: `About ${brand.name}` },
];
