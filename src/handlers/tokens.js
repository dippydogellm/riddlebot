import { q, ensureUser } from '../services/db.js';
import { requireWallet } from '../services/wallet.js';
import { parseAsset, assetKey, getTrustlines, getXrpBalance, fromCurrencyCode } from '../services/xrpl.js';
import { buyToken, sellToken, quoteBuy, quoteSell } from '../services/tokens.js';
import { api, safe } from '../services/api.js';
import { setState, clearState } from '../services/session.js';
import { ref, derefOrThrow } from '../services/refs.js';
import { buyKeyboard, sellKeyboard, backButton, mainMenu, editOrReply, requirePrivate, esc, num, pct, short } from '../ui/index.js';
import { adFooter } from '../brand.js';

/* ------------------------------------------------------------------ */

async function tokenCard(assetStr) {
  const asset = parseAsset(assetStr);
  const label = asset.label || fromCurrencyCode(asset.currency);
  const slug = `${asset.issuer}-${asset.currency}`;

  const [meta, quote] = await Promise.all([
    safe(api.token(slug)),
    safe(quoteBuy(asset, 10)),
  ]);

  const t = meta?.token || meta || {};
  const review = t.md5 ? await safe(api.review(t.md5)) : null;
  const lines = [
    `<b>${esc(label)}</b>  <code>${short(asset.issuer)}</code>`,
    '',
  ];

  if (t.exch || quote) {
    const priceXrp = quote ? quote.avgPrice : t.exch;
    lines.push(`Price:  <b>${num(priceXrp, 8)} XRP</b>${t.usd ? `  ($${num(t.usd, 6)})` : ''}`);
  }
  if (t.pro24h != null) lines.push(`24h:    ${pct(t.pro24h)}`);
  if (t.vol24hxrp != null) lines.push(`Volume: ${num(t.vol24hxrp, 0)} XRP`);
  if (t.marketcap != null) lines.push(`MCap:   ${num(t.marketcap, 0)}`);
  if (t.holders != null) lines.push(`Holders: ${num(t.holders, 0)}`);

  if (review?.score != null) {
    const s = review.score;
    const flag = s >= 70 ? '🟢' : s >= 40 ? '🟡' : '🔴';
    lines.push('', `Risk score: ${flag} <b>${s}/100</b>`);
    if (Array.isArray(review.warnings) && review.warnings.length) {
      lines.push(...review.warnings.slice(0, 3).map((w) => `⚠️ ${esc(w)}`));
    }
  }

  if (quote) {
    lines.push('', `10 XRP buys ≈ <b>${num(quote.received, 4)} ${esc(label)}</b>`);
  } else {
    lines.push('', '⚠️ Thin or empty order book — quotes may fail.');
  }

  lines.push('', `<code>${esc(assetStr)}</code>`);
  const text = lines.join('\n') + (await adFooter());
  return { text, asset, label, md5: t.md5 };
}

/* ------------------------------------------------------------------ */

export function registerTokens(bot) {
  const showBuy = async (ctx, assetStr, edit = false) => {
    try {
      const { text, asset, md5 } = await tokenCard(assetStr);
      const kb = buyKeyboard(ref(assetKey(asset)), md5);
      return edit
        ? editOrReply(ctx, text, { disable_web_page_preview: true, ...kb })
        : ctx.replyWithHTML(text, { disable_web_page_preview: true, ...kb });
    } catch (e) {
      return ctx.reply(`❌ ${e.message}`);
    }
  };

  bot.action('menu:buy', async (ctx) => {
    await ctx.answerCbQuery();
    setState(ctx.from.id, { awaiting: 'buy_asset' });
    await ctx.replyWithHTML(
      'Send the token as <code>CODE.issuer</code>, or just a name to search.\n\nExample: <code>SOLO.rsoLo2S1kiGeCcn6hCUXVrCpGMWLrRrLZz</code>',
      backButton(),
    );
  });

  bot.action(/^buy:show:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Refreshing…');
    try { await showBuy(ctx, derefOrThrow(ctx.match[1]), true); }
    catch (e) { await ctx.reply(`❌ ${e.message}`); }
  });

  bot.action(/^buy:custom:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    try {
      setState(ctx.from.id, { awaiting: 'buy_amount', asset: derefOrThrow(ctx.match[1]) });
      await ctx.reply('How much XRP do you want to spend?');
    } catch (e) { await ctx.reply(`❌ ${e.message}`); }
  });

  bot.action(/^buy:go:([^:]+):([0-9.]+)$/, async (ctx) => {
    await ctx.answerCbQuery('Building transaction…');
    if (!(await requirePrivate(ctx))) return;
    try { await executeBuy(ctx, derefOrThrow(ctx.match[1]), Number(ctx.match[2])); }
    catch (e) { await ctx.reply(`❌ ${e.message}`); }
  });

  /* ---------------------------------------------------------------- */

  bot.action('menu:sell', async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requirePrivate(ctx))) return;
    const user = ensureUser(ctx);
    if (!user.address) return ctx.reply('Connect a wallet first — /wallet');

    const lines = (await getTrustlines(user.address)).filter((l) => l.balance > 0);
    if (!lines.length) return ctx.replyWithHTML('You hold no tokens yet.', backButton());

    const rows = lines.slice(0, 20).map((l) => [{
      text: `${l.label} — ${num(l.balance, 4)}`,
      callback_data: `sell:pick:${ref(`${l.label}.${l.issuer}`)}`,
    }]);
    rows.push([{ text: '‹ Back', callback_data: 'menu:main' }]);

    await ctx.replyWithHTML('<b>Pick a token to sell</b>', { reply_markup: { inline_keyboard: rows } });
  });

  bot.action(/^sell:pick:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const assetStr = derefOrThrow(ctx.match[1]);
      const asset = parseAsset(assetStr);
      const wallet = requireWallet(ctx.from.id);
      const line = (await getTrustlines(wallet.address))
        .find((l) => l.currency === asset.currency && l.issuer === asset.issuer);

      const [quote, meta] = await Promise.all([
        safe(quoteSell(asset, line.balance)),
        safe(api.token(`${asset.issuer}-${asset.currency}`)),
      ]);
      const md5 = (meta?.token || meta)?.md5;
      await ctx.replyWithHTML(
        [
          `<b>Sell ${esc(line.label)}</b>`,
          '',
          `Holding: <b>${num(line.balance, 6)}</b>`,
          quote ? `Full exit ≈ <b>${num(quote.received, 4)} XRP</b>` : '⚠️ Thin book — may not fill.',
        ].join('\n'),
        sellKeyboard(ref(assetKey(asset)), md5),
      );
    } catch (e) {
      await ctx.reply(`❌ ${e.message}`);
    }
  });

  bot.action(/^sell:go:([^:]+):([0-9]+)$/, async (ctx) => {
    await ctx.answerCbQuery('Selling…');
    if (!(await requirePrivate(ctx))) return;
    try { await executeSell(ctx, derefOrThrow(ctx.match[1]), Number(ctx.match[2])); }
    catch (e) { await ctx.reply(`❌ ${e.message}`); }
  });

  bot.action(/^sell:custom:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    try {
      setState(ctx.from.id, { awaiting: 'sell_amount', asset: derefOrThrow(ctx.match[1]) });
      await ctx.reply('How many tokens do you want to sell?');
    } catch (e) { await ctx.reply(`❌ ${e.message}`); }
  });

  /* ---------------------------------------------------------------- */

  bot.action('menu:trending', async (ctx) => {
    await ctx.answerCbQuery('Loading…');
    const data = await safe(api.tokens(12, 'volume'));
    const list = data?.tokens || data?.data || [];

    if (!list.length) return ctx.reply('Market data is unavailable right now.');

    const rows = list.slice(0, 12).map((t) => {
      const code = fromCurrencyCode(t.currency);
      return [{
        text: `${code}  ${t.pro24h != null ? pct(t.pro24h) : ''}`.trim(),
        callback_data: `buy:show:${ref(`${code}.${t.issuer}`)}`,
      }];
    });
    rows.push([{ text: '‹ Back', callback_data: 'menu:main' }]);

    await ctx.replyWithHTML('<b>📊 Top by 24h volume</b>', { reply_markup: { inline_keyboard: rows } });
  });

  bot.action('menu:portfolio', async (ctx) => {
    await ctx.answerCbQuery('Loading…');
    if (!(await requirePrivate(ctx))) return;
    const user = ensureUser(ctx);
    if (!user.address) return ctx.reply('Connect a wallet first — /wallet');

    const [xrp, lines] = await Promise.all([
      getXrpBalance(user.address),
      getTrustlines(user.address),
    ]);
    const held = lines.filter((l) => l.balance > 0);

    const valued = await Promise.all(
      held.slice(0, 15).map(async (l) => {
        const qt = await safe(quoteSell({ currency: l.currency, issuer: l.issuer }, l.balance));
        return { ...l, xrpValue: qt?.received ?? null };
      }),
    );
    valued.sort((a, b) => (b.xrpValue ?? 0) - (a.xrpValue ?? 0));

    const tokenTotal = valued.reduce((s, v) => s + (v.xrpValue ?? 0), 0);
    const body = valued.map(
      (v) => `${esc(v.label).padEnd(10)} ${num(v.balance, 4)}  ≈ ${v.xrpValue != null ? num(v.xrpValue, 3) + ' XRP' : '—'}`,
    );

    const socials = [
      user.social_x && `X: ${esc(user.social_x)}`,
      user.social_telegram && `Telegram: ${esc(user.social_telegram)}`,
      user.social_discord && `Discord: ${esc(user.social_discord)}`,
      user.social_website && `Web: ${esc(user.social_website)}`,
    ].filter(Boolean);

    await ctx.replyWithHTML(
      [
        '<b>📁 Portfolio</b>',
        '',
        `XRP:    <b>${num(xrp, 4)}</b>`,
        `Tokens: <b>${num(tokenTotal, 4)} XRP</b>`,
        `Total:  <b>${num(xrp + tokenTotal, 4)} XRP</b>`,
        '',
        body.length ? `<pre>${body.join('\n')}</pre>` : 'No token positions.',
        socials.length ? `\n${socials.join(' · ')}` : '',
      ].filter(Boolean).join('\n'),
      backButton(),
    );
  });

  /* Shared execution ------------------------------------------------- */

  async function executeBuy(ctx, assetStr, xrpAmount) {
    const user = ensureUser(ctx);
    let pending;
    try {
      const wallet = requireWallet(ctx.from.id);
      const asset = parseAsset(assetStr);
      pending = await ctx.reply(`Buying ${xrpAmount} XRP of ${asset.label}…`);

      const res = await buyToken(wallet, asset, xrpAmount, {
        slippageBps: user.slippage_bps,
        autoTrustline: !!user.auto_trustline,
      });

      q.logTrade.run({
        tg_id: ctx.from.id, kind: 'buy', asset: res.asset,
        spent_xrp: xrpAmount, received: res.filled,
        tx_hash: res.hash, status: 'filled', created_at: Date.now(),
      });

      await ctx.telegram.editMessageText(
        ctx.chat.id, pending.message_id, undefined,
        [
          `✅ <b>Bought ${num(res.filled, 6)} ${esc(asset.label)}</b>`,
          '',
          `Spent: ${num(xrpAmount, 4)} XRP`,
          `Price: ${num(res.price, 8)} XRP each`,
          res.trustlineCreated ? 'Trustline opened (0.2 XRP reserved)' : '',
          '',
          res.explorer,
        ].filter(Boolean).join('\n'),
        { parse_mode: 'HTML', disable_web_page_preview: true },
      );
    } catch (e) {
      const msg = `❌ ${e.message}`;
      if (pending) {
        await ctx.telegram.editMessageText(ctx.chat.id, pending.message_id, undefined, msg).catch(() => {});
      } else {
        await ctx.reply(msg);
      }
    }
  }

  async function executeSell(ctx, assetStr, percentOrAmount, isPercent = true) {
    const user = ensureUser(ctx);
    let pending;
    try {
      const wallet = requireWallet(ctx.from.id);
      const asset = parseAsset(assetStr);

      let amount;
      if (isPercent) {
        const line = (await getTrustlines(wallet.address))
          .find((l) => l.currency === asset.currency && l.issuer === asset.issuer);
        if (!line || line.balance <= 0) throw new Error('You hold none of that token.');
        amount = percentOrAmount >= 100 ? line.balance : line.balance * (percentOrAmount / 100);
      } else {
        amount = percentOrAmount;
      }

      pending = await ctx.reply(`Selling ${num(amount, 6)} ${asset.label}…`);
      const res = await sellToken(wallet, asset, amount, { slippageBps: user.slippage_bps });

      q.logTrade.run({
        tg_id: ctx.from.id, kind: 'sell', asset: res.asset,
        spent_xrp: null, received: res.filled,
        tx_hash: res.hash, status: 'filled', created_at: Date.now(),
      });

      await ctx.telegram.editMessageText(
        ctx.chat.id, pending.message_id, undefined,
        `✅ <b>Sold ${num(amount, 6)} ${esc(asset.label)}</b>\n\nReceived: ${num(res.filled, 4)} XRP\n\n${res.explorer}`,
        { parse_mode: 'HTML', disable_web_page_preview: true },
      );
    } catch (e) {
      const msg = `❌ ${e.message}`;
      if (pending) {
        await ctx.telegram.editMessageText(ctx.chat.id, pending.message_id, undefined, msg).catch(() => {});
      } else {
        await ctx.reply(msg);
      }
    }
  }

  /* Text steps -------------------------------------------------------- */

  return {
    showBuy,
    async handleText(ctx, state) {
      const text = ctx.message.text.trim();

      if (state.awaiting === 'buy_asset') {
        clearState(ctx.from.id);
        if (text.includes('.') || text.includes(':')) return showBuy(ctx, text), true;

        const results = await safe(api.search(text, 8));
        const list = results?.tokens || results?.data || [];
        if (!list.length) {
          await ctx.reply('Nothing found. Try the full CODE.issuer pair.');
          return true;
        }

        const rows = list.slice(0, 8).map((t) => {
          const code = fromCurrencyCode(t.currency);
          return [{ text: `${code} — ${t.name || short(t.issuer)}`, callback_data: `buy:show:${ref(`${code}.${t.issuer}`)}` }];
        });
        await ctx.replyWithHTML('<b>Search results</b>', { reply_markup: { inline_keyboard: rows } });
        return true;
      }

      if (state.awaiting === 'buy_amount') {
        clearState(ctx.from.id);
        if (!(await requirePrivate(ctx))) return true;
        const amount = Number(text);
        if (!(amount > 0)) { await ctx.reply('Enter a positive number of XRP.'); return true; }
        await executeBuy(ctx, state.asset, amount);
        return true;
      }

      if (state.awaiting === 'sell_amount') {
        clearState(ctx.from.id);
        if (!(await requirePrivate(ctx))) return true;
        const amount = Number(text);
        if (!(amount > 0)) { await ctx.reply('Enter a positive token amount.'); return true; }
        await executeSell(ctx, state.asset, amount, false);
        return true;
      }

      return false;
    },
  };
}
