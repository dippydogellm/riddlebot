import { q, ensureUser } from '../services/db.js';
import { parseAsset, assetKey, fromCurrencyCode } from '../services/xrpl.js';
import { quoteBuy } from '../services/tokens.js';
import { setState, clearState } from '../services/session.js';
import { ref, derefOrThrow } from '../services/refs.js';
import { api, safe } from '../services/api.js';
import { links } from '../brand.js';
import { settingsMenu, backButton, editOrReply, esc, num, short } from '../ui/index.js';
import { config } from '../config.js';

/** Human label for a watch row: token code, collection slug, or short NFT id. */
function watchLabel(asset) {
  if (asset.startsWith('col:')) return `${asset.slice(4)} (collection)`;
  if (asset.length === 64) return `NFT ${asset.slice(0, 8)}…`;
  return asset.split('.')[0];
}

async function addBuyWatch(ctx, asset) {
  // High-water mark starts at "now" so existing history doesn't replay as new.
  q.addBuyWatch.run({
    tg_id: ctx.from.id, asset, last_seen: Date.now(), created_at: Date.now(),
  });
  await ctx.reply(`🟢 Watching ${watchLabel(asset)} for new buys.`);
}

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
      text: w.kind === 'buys'
        ? `🟢 buys · ${watchLabel(w.asset)}  ✖`
        : `${w.asset.split('.')[0]} ${w.direction} ${num(w.target, 8)} XRP  ✖`,
      callback_data: `alert:del:${w.id}`,
    }]);
    rows.push([{ text: '➕ Price alert', callback_data: 'alert:new' }]);
    rows.push([{ text: '🟢 Watch new buys', callback_data: 'alert:buys' }]);
    rows.push([{ text: '‹ Back', callback_data: 'menu:main' }]);

    await ctx.replyWithHTML(
      rows.length > 3 ? '<b>🔔 Your alerts</b>' : '<b>🔔 Alerts</b>\n\nNone set.',
      { reply_markup: { inline_keyboard: rows } },
    );
  });

  bot.action('alert:buys', async (ctx) => {
    await ctx.answerCbQuery();
    setState(ctx.from.id, { awaiting: 'watch_buys' });
    await ctx.replyWithHTML(
      [
        '<b>🟢 Watch new buys</b>',
        '',
        'Send any of:',
        '• a token name, e.g. <code>SOLO</code>',
        '• an NFT collection name, e.g. <code>xPEPE</code>',
        '• a <code>CODE.issuer</code> pair',
        '• a 64-character NFTokenID',
        '',
        'You get a ping each time it is bought.',
      ].join('\n'),
    );
  });

  bot.action(/^watch:add:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    try { await addBuyWatch(ctx, derefOrThrow(ctx.match[1])); }
    catch (e) { await ctx.reply(`❌ ${e.message}`); }
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

      if (state.awaiting === 'watch_buys') {
        clearState(ctx.from.id);
        const raw = text.trim();

        // Exact identifiers go straight in.
        if (/^[0-9A-F]{64}$/i.test(raw)) { await addBuyWatch(ctx, raw.toUpperCase()); return true; }
        if (raw.includes('.') || raw.includes(':')) {
          try { await addBuyWatch(ctx, assetKey(parseAsset(raw))); }
          catch (e) { await ctx.reply(`❌ ${e.message}`); }
          return true;
        }

        // Otherwise treat it as a name and let them pick — requiring people to
        // know a token's issuer address or a collection's exact slug is why
        // this step was unusable.
        const res = await safe(api.search(raw, 8));
        const toks = (res?.tokens || []).slice(0, 6);
        const cols = (res?.collections || []).slice(0, 6);
        if (!toks.length && !cols.length) {
          await ctx.reply('Nothing matched. Try a CODE.issuer pair, an NFTokenID, or another name.');
          return true;
        }

        const rows = [
          ...toks.map((t) => {
            const code = fromCurrencyCode(t.currency);
            return [{ text: `🪙 ${code} — ${t.name || short(t.issuer)}`,
                     callback_data: `watch:add:${ref(`${code}.${t.issuer}`)}` }];
          }),
          ...cols.map((c) => [{ text: `🖼 ${c.name || c.slug} (collection)`,
                               callback_data: `watch:add:${ref(`col:${c.slug}`)}` }]),
        ];
        await ctx.replyWithHTML('<b>Pick what to watch</b>', { reply_markup: { inline_keyboard: rows } });
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

/** Green blocks scaled to buy size — the visual cue every buy bot leads with. */
function sizeBar(xrp) {
  if (!(xrp > 0)) return '';
  const n = Math.min(48, Math.max(1, Math.round(Math.sqrt(xrp))));
  return '🟢'.repeat(n);
}

const compact = (v) =>
  v == null ? null : Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(v);

/** Notifies on new fills for a 'buys' watch and advances its high-water mark. */
async function checkBuyWatch(bot, w) {
  const isCollection = w.asset.startsWith('col:');
  const isNft = !isCollection && w.asset.length === 64;

  let trades = [];
  let t0 = {};
  let md5 = null;

  if (isCollection) {
    const res = await safe(api.collectionHistory(w.asset.slice(4), 30));
    // The feed is mostly offer churn; only SALE is an actual buy.
    trades = (res?.history || []).filter((e) => e.type === 'SALE');
  } else if (isNft) {
    const res = await safe(api.nftHistory(w.asset, 10));
    trades = res?.history || res?.data || [];
  } else {
    const asset = parseAsset(w.asset);
    const meta = await safe(api.token(`${asset.issuer}-${asset.currency}`));
    t0 = meta?.token || meta || {};
    md5 = t0.md5;
    if (!md5) return;
    const res = await safe(api.history(md5, 10));
    trades = res?.data || res?.history || [];
  }

  const since = w.last_seen || 0;
  const label = watchLabel(w.asset);

  const fresh = trades
    .map((t) => ({ ...t, _t: Number(t.time || t.timestamp || 0) }))
    .filter((t) => t._t > since)
    // For tokens, only acquisitions of the watched asset count as a buy — the
    // same feed carries sells, which would otherwise fire a green "New BUY".
    // NFT and collection feeds are already filtered to sales.
    .filter((t) => (isNft || isCollection
      ? true
      : t.got?.currency === t0.currency || t.got?.issuer === t0.issuer))
    .sort((a, b) => a._t - b._t);

  if (!fresh.length) return;
  q.setWatchSeen.run(fresh[fresh.length - 1]._t, w.id);

  // USD per XRP, derived from the token's own quote so no extra request.
  const usdPerXrp = t0.usd && t0.exch ? Number(t0.usd) / Number(t0.exch) : null;

  // Cap the burst: a busy token shouldn't spam a hundred messages at once.
  for (const t of fresh.slice(-3)) {
    // NFT sales price the whole item; token fills price what was received.
    const gotAmt = isCollection || isNft ? null : (Number(t.got?.value ?? t.amount ?? 0) || null);
    // Routes that never touch XRP (token-to-token, AMM hops) still need a size
    // to show, so fall back to valuing what was received at the token's rate.
    const xrpSpent = isCollection || isNft
      ? (Number(t.costXRP) || Number(t.cost?.amount) || Number(t.amount) || null)
      : (t.paid?.currency === 'XRP'
        ? Number(t.paid.value)
        : (Number(t._mergedXrp) || (gotAmt && t0.exch ? gotAmt * Number(t0.exch) : null)));
    const usd = xrpSpent && usdPerXrp ? xrpSpent * usdPerXrp : null;

    const buyer = t.taker || t.buyer;
    const row2 = [
      t.hash ? `<a href="${links.tx(t.hash)}">TX</a>` : null,
      buyer ? `<a href="${links.account(buyer)}">Buyer</a>` : null,
      md5 ? `<a href="${links.scanner(md5)}">Chart</a>` : null,
      `<a href="${links.trending}">Trending</a>`,
    ].filter(Boolean).join(' | ');

    const lines = [
      `🆕 <b>New BUY</b> <b>${esc(label)}</b>`,
      sizeBar(xrpSpent),
      '',
      xrpSpent ? `🔻 <b>${num(xrpSpent, 4)} XRP</b>${usd ? ` | $${num(usd, 2)}` : ''}` : null,
      gotAmt ? `🔺 <b>${num(gotAmt, 2)} ${esc(label)}</b>` : null,
      isCollection && t.NFTokenID ? `🖼 <code>${t.NFTokenID.slice(0, 16)}…</code>` : null,
      t.isAMM ? '💠 via AMM' : null,
      row2 ? `🏷 ${row2}` : null,
      '',
      t0.marketcap != null ? `🏛 Market Cap: <b>$${compact(t0.marketcap)}</b>` : null,
      t0.holders != null ? `👤 Hold: <b>${compact(t0.holders)}</b> | Trust: <b>${compact(t0.trustlines ?? t0.lines)}</b>` : null,
    ].filter((l) => l !== null); // keep '' — those are the deliberate blank separators

    await bot.telegram.sendMessage(
      w.tg_id,
      lines.join('\n'),
      {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [[
            ...(isNft || isCollection
              ? [] : [{ text: '💰 Buy now', callback_data: `buy:show:${ref(w.asset)}` }]),
            { text: '🔄 Swap', url: links.swap },
          ]],
        },
      },
    );
  }
}

/** Polls watched assets and fires alerts. */
export function startAlertLoop(bot, intervalMs = 60_000) {
  const timer = setInterval(async () => {
    const watches = q.allWatch.all();
    for (const w of watches) {
      try {
        if (w.kind === 'buys') { await checkBuyWatch(bot, w); continue; }

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
