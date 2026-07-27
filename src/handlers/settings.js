import { q, ensureUser } from '../services/db.js';
import { parseAsset, assetKey } from '../services/xrpl.js';
import { quoteBuy } from '../services/tokens.js';
import { setState, clearState } from '../services/session.js';
import { ref } from '../services/refs.js';
import { settingsMenu, backButton, editOrReply, esc, num } from '../ui/index.js';
import { config } from '../config.js';

export function registerSettings(bot) {
  bot.action('menu:settings', async (ctx) => {
    await ctx.answerCbQuery();
    const user = ensureUser(ctx);
    await editOrReply(ctx, '<b>⚙️ Settings</b>', settingsMenu(user));
  });

  bot.action('set:slippage', async (ctx) => {
    await ctx.answerCbQuery();
    setState(ctx.from.id, { awaiting: 'slippage' });
    await ctx.reply('Send slippage tolerance as a percentage, e.g. 3 or 12.5');
  });

  bot.action('set:socials', async (ctx) => {
    await ctx.answerCbQuery();
    const user = ensureUser(ctx);
    setState(ctx.from.id, { awaiting: 'socials' });
    await ctx.replyWithHTML(
      [
        '<b>🌐 My socials</b>',
        '',
        'Send 4 lines — X/Twitter, Telegram, Discord, Website. Use <code>-</code> to leave one blank.',
        '',
        `<code>${esc(user.social_x || '-')}\n${esc(user.social_telegram || '-')}\n${esc(user.social_discord || '-')}\n${esc(user.social_website || '-')}</code>`,
      ].join('\n'),
    );
  });

  bot.action('set:trustline', async (ctx) => {
    const user = ensureUser(ctx);
    const next = user.auto_trustline ? 0 : 1;
    q.setAutoTrustline.run(next, ctx.from.id);
    await ctx.answerCbQuery(next ? 'Auto-trustline on' : 'Auto-trustline off');
    await editOrReply(ctx, '<b>⚙️ Settings</b>', settingsMenu(q.getUser.get(ctx.from.id)));
  });

  /* Alerts ----------------------------------------------------------- */

  bot.action('menu:alerts', async (ctx) => {
    await ctx.answerCbQuery();
    const rows = q.listWatch.all(ctx.from.id).map((w) => [{
      text: `${w.asset.split('.')[0]} ${w.direction} ${num(w.target, 8)} XRP  ✖`,
      callback_data: `alert:del:${w.id}`,
    }]);
    rows.push([{ text: '➕ New alert', callback_data: 'alert:new' }]);
    rows.push([{ text: '‹ Back', callback_data: 'menu:main' }]);

    await ctx.replyWithHTML(
      rows.length > 2 ? '<b>🔔 Your alerts</b>' : '<b>🔔 Alerts</b>\n\nNone set.',
      { reply_markup: { inline_keyboard: rows } },
    );
  });

  bot.action('alert:new', async (ctx) => {
    await ctx.answerCbQuery();
    setState(ctx.from.id, { awaiting: 'alert' });
    await ctx.replyWithHTML(
      'Send: <code>CODE.issuer above|below price</code>\n\nExample: <code>SOLO.rsoLo2S1... above 0.15</code>',
    );
  });

  bot.action(/^alert:del:(\d+)$/, async (ctx) => {
    q.deleteWatch.run(Number(ctx.match[1]), ctx.from.id);
    await ctx.answerCbQuery('Deleted');
    await ctx.deleteMessage().catch(() => {});
  });

  /* History ---------------------------------------------------------- */

  bot.command('history', async (ctx) => {
    const rows = q.recentTrades.all(ctx.from.id, 15);
    if (!rows.length) return ctx.reply('No trades yet.');

    const body = rows.map((r) => {
      const when = new Date(r.created_at).toISOString().slice(5, 16).replace('T', ' ');
      const sym = r.asset.length === 64 ? 'NFT' : r.asset.split('.')[0];
      return `${when}  ${r.kind.padEnd(8)} ${sym.padEnd(8)} ${r.spent_xrp ? `-${num(r.spent_xrp, 3)} XRP` : `+${num(r.received, 3)} XRP`}`;
    });

    await ctx.replyWithHTML(`<b>Recent trades</b>\n<pre>${esc(body.join('\n'))}</pre>`);
  });

  return {
    async handleText(ctx, state) {
      const text = ctx.message.text.trim();

      if (state.awaiting === 'slippage') {
        clearState(ctx.from.id);
        const pctVal = Number(text.replace('%', ''));
        if (!(pctVal > 0) || pctVal > config.trading.maxSlippageBps / 100) {
          await ctx.reply(`Enter a percentage between 0.1 and ${config.trading.maxSlippageBps / 100}.`);
          return true;
        }
        q.setSlippage.run(Math.round(pctVal * 100), ctx.from.id);
        await ctx.reply(`Slippage set to ${pctVal}%.`);
        return true;
      }

      if (state.awaiting === 'socials') {
        clearState(ctx.from.id);
        const lines = text.split('\n').map((l) => l.trim());
        const clean = (l) => (!l || l === '-' ? null : l.slice(0, 100));
        q.setSocials.run({
          tg_id: ctx.from.id,
          x: clean(lines[0]),
          telegram: clean(lines[1]),
          discord: clean(lines[2]),
          website: clean(lines[3]),
        });
        await ctx.reply('✅ Socials updated.');
        return true;
      }

      if (state.awaiting === 'alert') {
        clearState(ctx.from.id);
        const [assetStr, direction, priceRaw] = text.split(/\s+/);
        const price = Number(priceRaw);

        if (!['above', 'below'].includes(direction) || !(price > 0)) {
          await ctx.reply('Format: CODE.issuer above|below price');
          return true;
        }

        try {
          const asset = parseAsset(assetStr);
          q.addWatch.run({
            tg_id: ctx.from.id, asset: assetKey(asset),
            target: price, direction, created_at: Date.now(),
          });
          await ctx.reply(`🔔 Alert set: ${asset.label} ${direction} ${price} XRP`);
        } catch (e) {
          await ctx.reply(`❌ ${e.message}`);
        }
        return true;
      }

      return false;
    },
  };
}

/* ------------------------------------------------------------------ */

/** Polls watched assets and fires one-shot alerts. */
export function startAlertLoop(bot, intervalMs = 60_000) {
  const timer = setInterval(async () => {
    const watches = q.allWatch.all();
    for (const w of watches) {
      try {
        const asset = parseAsset(w.asset);
        const quote = await quoteBuy(asset, 10);
        const price = quote.avgPrice;

        const hit = w.direction === 'above' ? price >= w.target : price <= w.target;
        if (!hit) continue;

        await bot.telegram.sendMessage(
          w.tg_id,
          `🔔 <b>${esc(asset.label)}</b> is ${w.direction} ${num(w.target, 8)} XRP\n\nNow: <b>${num(price, 8)} XRP</b>`,
          {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '💰 Buy now', callback_data: `buy:show:${ref(w.asset)}` }]] },
          },
        );
        q.deleteWatch.run(w.id, w.tg_id);
      } catch {
        /* a dead book or rate limit shouldn't kill the loop */
      }
    }
  }, intervalMs);

  timer.unref();
  return timer;
}
