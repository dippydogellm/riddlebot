import { xrpToDrops } from 'xrpl';
import { ensureUser, q } from '../services/db.js';
import { createWallet, importWallet, loadWallet, exportSeed, forgetWallet, requireWallet } from '../services/wallet.js';
import { getXrpBalance, getTrustlines, submit } from '../services/xrpl.js';
import { setState, clearState } from '../services/session.js';
import { mainMenu, walletMenu, backButton, confirmKeyboard, editOrReply, esc, num, short } from '../ui/index.js';
import { config } from '../config.js';
import { brand, footer, adFooter, sendLogo } from '../brand.js';

const welcomeText = async () => `<b>${brand.name}</b>
<i>${brand.tagline}</i>

• Market buy and sell any XRPL token — trustlines handled automatically
• Sweep NFT floors or place timed bids
• Live pricing and risk scores before you commit
• Your seed, exportable at any time

Tap <b>Wallet</b> to get started, or paste any <code>CODE.issuer</code> pair or NFTokenID to jump straight to a trade.

${footer()}${await adFooter()}`;

export function registerWallet(bot) {
  bot.start(async (ctx) => {
    ensureUser(ctx);
    await sendLogo(ctx, await welcomeText(), { ...mainMenu() });
  });

  bot.command('menu', async (ctx) => {
    ensureUser(ctx);
    await ctx.replyWithHTML(`<b>${brand.name}</b>`, mainMenu());
  });

  bot.action('menu:main', async (ctx) => {
    await ctx.answerCbQuery();
    await editOrReply(ctx, `<b>${brand.name}</b>`, mainMenu());
  });

  bot.command('about', async (ctx) => {
    await sendLogo(ctx, [
      `<b>${brand.name}</b>`,
      `<i>${brand.tagline}</i>`,
      '',
      `Part of the ${brand.suite} suite on the XRP Ledger.`,
      brand.support ? `Support: ${brand.support}` : '',
      '',
      footer() + await adFooter(),
    ].filter(Boolean).join('\n'));
  });

  /* ---------------------------------------------------------------- */

  const showWallet = async (ctx, edit = false) => {
    const user = ensureUser(ctx);

    if (!user.address) {
      const text = 'No wallet connected yet.\n\nCreate a fresh one, or import a seed you already control.';
      const kb = walletMenu(false);
      return edit
        ? editOrReply(ctx, text, kb)
        : ctx.replyWithHTML(text, kb);
    }

    const [xrp, lines] = await Promise.all([
      getXrpBalance(user.address),
      getTrustlines(user.address),
    ]);
    const held = lines.filter((l) => l.balance > 0);
    const reserve = config.limits.reserveBufferXrp + lines.length * config.limits.ownerReserveXrp;

    const text = [
      '<b>👛 Your wallet</b>',
      '',
      `<code>${esc(user.address)}</code>`,
      '',
      `Balance:   <b>${num(xrp, 4)} XRP</b>`,
      `Spendable: ${num(Math.max(0, xrp - reserve), 4)} XRP`,
      `Tokens held: ${held.length}  ·  Trustlines: ${lines.length}`,
    ].join('\n');

    const kb = walletMenu(true);
    return edit
      ? editOrReply(ctx, text, kb)
      : ctx.replyWithHTML(text, kb);
  };

  bot.command('wallet', (ctx) => showWallet(ctx));
  bot.action('menu:wallet', async (ctx) => { await ctx.answerCbQuery(); await showWallet(ctx, true); });
  bot.action('wallet:refresh', async (ctx) => { await ctx.answerCbQuery('Refreshing…'); await showWallet(ctx, true); });

  /* ---------------------------------------------------------------- */

  bot.action('wallet:create', async (ctx) => {
    await ctx.answerCbQuery();
    ensureUser(ctx);
    if (q.getUser.get(ctx.from.id)?.address) {
      return ctx.reply('You already have a wallet. Remove it first if you want a new one.');
    }

    const w = createWallet(ctx.from.id);
    await ctx.replyWithHTML(
      [
        '<b>✅ Wallet created</b>',
        '',
        `Address:\n<code>${esc(w.address)}</code>`,
        '',
        `Seed (save this now, it will not be shown again):\n<tg-spoiler><code>${esc(w.seed)}</code></tg-spoiler>`,
        '',
        `⚠️ Fund it with at least <b>${config.limits.reserveBufferXrp + 1} XRP</b> — the ledger holds a base reserve, plus 0.2 XRP per trustline.`,
        '',
        'Anyone with that seed owns the funds. Delete this message once you have stored it somewhere safe.',
      ].join('\n'),
      backButton('menu:wallet'),
    );
  });

  bot.action('wallet:import', async (ctx) => {
    await ctx.answerCbQuery();
    setState(ctx.from.id, { awaiting: 'import_seed' });
    await ctx.replyWithHTML(
      'Send your family seed (starts with <code>s</code>).\n\nI will delete your message immediately after reading it.',
      backButton('menu:wallet'),
    );
  });

  bot.action('wallet:export', async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const seed = exportSeed(ctx.from.id);
      const msg = await ctx.replyWithHTML(
        `<b>🔑 Your seed</b>\n\n<tg-spoiler><code>${esc(seed)}</code></tg-spoiler>\n\nThis message self-destructs in 60 seconds.`,
      );
      setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 60_000);
    } catch (e) {
      await ctx.reply(e.message);
    }
  });

  bot.action('wallet:forget', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(
      '<b>Remove wallet?</b>\n\nI will erase the encrypted seed from my database. If you have not exported it, the funds are gone for good.',
      confirmKeyboard('wallet:forget:yes', 'menu:wallet'),
    );
  });

  bot.action('wallet:forget:yes', async (ctx) => {
    await ctx.answerCbQuery();
    forgetWallet(ctx.from.id);
    await editOrReply(ctx, 'Wallet removed.', backButton('menu:main'));
  });

  /* ---------------------------------------------------------------- */

  bot.action('wallet:withdraw', async (ctx) => {
    await ctx.answerCbQuery();
    setState(ctx.from.id, { awaiting: 'withdraw' });
    await ctx.replyWithHTML(
      'Send: <code>rDestinationAddress amount</code>\n\nExample: <code>rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe 25</code>\nUse <code>max</code> for the amount to send everything above reserve.',
      backButton('menu:wallet'),
    );
  });

  /* Text steps owned by this module ---------------------------------- */

  return {
    async handleText(ctx, state) {
      if (state.awaiting === 'import_seed') {
        clearState(ctx.from.id);
        await ctx.deleteMessage().catch(() => {});
        try {
          const w = importWallet(ctx.from.id, ctx.message.text);
          await ctx.replyWithHTML(`<b>✅ Imported</b>\n\n<code>${esc(w.address)}</code>`, backButton('menu:wallet'));
        } catch (e) {
          await ctx.reply(e.message);
        }
        return true;
      }

      if (state.awaiting === 'withdraw') {
        clearState(ctx.from.id);
        const [dest, rawAmount] = ctx.message.text.trim().split(/\s+/);

        if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(dest || '')) {
          await ctx.reply('That destination address is not valid.');
          return true;
        }

        try {
          const wallet = requireWallet(ctx.from.id);
          const balance = await getXrpBalance(wallet.address);
          const lines = await getTrustlines(wallet.address);
          const reserve = config.limits.reserveBufferXrp + lines.length * config.limits.ownerReserveXrp;
          const spendable = balance - reserve - 0.01;

          const amount = rawAmount === 'max' ? spendable : Number(rawAmount);
          if (!(amount > 0)) throw new Error('Amount must be a positive number.');
          if (amount > spendable) throw new Error(`Max you can send is ${num(spendable, 4)} XRP.`);

          const pending = await ctx.reply('Submitting…');
          const res = await submit(wallet, {
            TransactionType: 'Payment',
            Account: wallet.address,
            Destination: dest,
            Amount: xrpToDrops(amount.toFixed(6)),
          });

          await ctx.telegram.editMessageText(
            ctx.chat.id, pending.message_id, undefined,
            res.ok
              ? `✅ Sent ${num(amount, 4)} XRP to ${short(dest)}\n\n${res.explorer}`
              : `❌ Failed: ${res.code}`,
          );
        } catch (e) {
          await ctx.reply(`❌ ${e.message}`);
        }
        return true;
      }

      return false;
    },
  };
}
