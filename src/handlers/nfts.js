import { q, ensureUser } from '../services/db.js';
import { requireWallet } from '../services/wallet.js';
import { getAccountNfts } from '../services/xrpl.js';
import {
  getSellOffers, getBuyOffers, buyNftFloor, makeBid, listNft, acceptBid, decodeUri,
} from '../services/nfts.js';
import { api, safe } from '../services/api.js';
import { setState, clearState } from '../services/session.js';
import { ref, derefOrThrow } from '../services/refs.js';
import { nftMenu, nftActions, backButton, editOrReply, requirePrivate, esc, num, short } from '../ui/index.js';

const NFTOKEN_ID = /^[0-9A-F]{64}$/i;

export function registerNfts(bot) {
  const showNft = async (ctx, nftokenId, edit = false) => {
    const [offers, bids, meta] = await Promise.all([
      getSellOffers(nftokenId),
      getBuyOffers(nftokenId),
      safe(api.nft(nftokenId)),
    ]);

    const n = meta?.nft || meta || {};
    const floor = offers.find((o) => o.isXrp && !o.destination);
    const topBid = bids.find((b) => b.isXrp);

    const lines = [
      `<b>${esc(n.name || 'NFT')}</b>`,
      n.collection ? esc(n.collection) : '',
      '',
      `Owner: <code>${short(n.account || offers[0]?.owner || '')}</code>`,
      n.rarity_rank ? `Rarity: #${n.rarity_rank}` : '',
      '',
      floor ? `Floor ask: <b>${num(floor.price, 4)} XRP</b>` : 'No public sell offer.',
      topBid ? `Top bid:   ${num(topBid.price, 4)} XRP` : 'No bids.',
      offers.length > 1 ? `${offers.length} listings open` : '',
      '',
      `<code>${nftokenId}</code>`,
    ].filter(Boolean);

    const uri = decodeUri(n.uri || n.URI);
    if (uri) lines.push('', `<a href="${esc(uri)}">Metadata</a>`);

    const kb = nftActions(ref(nftokenId), !!floor);
    const opts = { parse_mode: 'HTML', disable_web_page_preview: true, ...kb };
    return edit ? editOrReply(ctx, lines.join('\n'), opts) : ctx.replyWithHTML(lines.join('\n'), opts);
  };

  /* ---------------------------------------------------------------- */

  bot.action('menu:nft', async (ctx) => {
    await ctx.answerCbQuery();
    await editOrReply(ctx, '<b>🖼 NFTs</b>\n\nBrowse collections, or paste any NFTokenID directly.', nftMenu());
  });

  bot.action('nft:collections', async (ctx) => {
    await ctx.answerCbQuery('Loading…');
    const data = await safe(api.collections(12));
    const list = data?.collections || data?.data || [];
    if (!list.length) return ctx.reply('Collection data is unavailable right now.');

    const rows = list.slice(0, 12).map((c) => [{
      text: `${c.name} — floor ${num(c.floor?.amount ?? c.floor, 2)} XRP`,
      callback_data: `nft:col:${ref(c.slug || c.uuid)}`,
    }]);
    rows.push([{ text: '‹ Back', callback_data: 'menu:nft' }]);

    await ctx.replyWithHTML('<b>🔥 Top collections by volume</b>', { reply_markup: { inline_keyboard: rows } });
  });

  bot.action(/^nft:col:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Loading listings…');
    let slug;
    try { slug = derefOrThrow(ctx.match[1]); } catch (e) { return ctx.reply(`❌ ${e.message}`); }
    const data = await safe(api.collectionNfts(slug, 10));
    const list = data?.nfts || data?.data || [];
    if (!list.length) return ctx.reply('No NFTs currently listed in that collection.');

    const rows = list.slice(0, 10).map((n) => [{
      text: `${n.name || short(n.NFTokenID)} — ${num(n.cost?.amount ?? n.amount, 2)} XRP`,
      callback_data: `nft:show:${ref(n.NFTokenID)}`,
    }]);
    rows.push([{ text: '‹ Back', callback_data: 'nft:collections' }]);

    await ctx.replyWithHTML('<b>Listed now</b>', { reply_markup: { inline_keyboard: rows } });
  });

  bot.action('nft:byid', async (ctx) => {
    await ctx.answerCbQuery();
    setState(ctx.from.id, { awaiting: 'nft_id' });
    await ctx.reply('Paste the 64-character NFTokenID.');
  });

  bot.action(/^nft:show:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Refreshing…');
    try {
      const id = derefOrThrow(ctx.match[1]);
      await showNft(ctx, id, true).catch(() => showNft(ctx, id));
    } catch (e) { await ctx.reply(`❌ ${e.message}`); }
  });

  /* Buying ----------------------------------------------------------- */

  bot.action(/^nft:buy:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Sweeping floor…');
    if (!(await requirePrivate(ctx))) return;
    let pending, nftokenId;
    try {
      nftokenId = derefOrThrow(ctx.match[1]);
      const wallet = requireWallet(ctx.from.id);
      pending = await ctx.reply('Accepting cheapest listing…');
      const res = await buyNftFloor(wallet, nftokenId);

      q.logTrade.run({
        tg_id: ctx.from.id, kind: 'nft_buy', asset: nftokenId,
        spent_xrp: res.price, received: 1,
        tx_hash: res.hash, status: 'filled', created_at: Date.now(),
      });

      await ctx.telegram.editMessageText(
        ctx.chat.id, pending.message_id, undefined,
        `✅ <b>NFT purchased</b>\n\nPaid: ${num(res.price, 4)} XRP\n\n${res.explorer}`,
        { parse_mode: 'HTML', disable_web_page_preview: true },
      );
    } catch (e) {
      const msg = `❌ ${e.message}`;
      pending
        ? await ctx.telegram.editMessageText(ctx.chat.id, pending.message_id, undefined, msg).catch(() => {})
        : await ctx.reply(msg);
    }
  });

  bot.action(/^nft:bid:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requirePrivate(ctx))) return;
    try {
      setState(ctx.from.id, { awaiting: 'nft_bid', nftokenId: derefOrThrow(ctx.match[1]) });
      await ctx.replyWithHTML(
        'How much XRP do you want to bid?\n\nOptionally add hours until it expires: <code>50 24</code>',
      );
    } catch (e) { await ctx.reply(`❌ ${e.message}`); }
  });

  /* My NFTs ---------------------------------------------------------- */

  bot.action('nft:mine', async (ctx) => {
    await ctx.answerCbQuery('Loading…');
    if (!(await requirePrivate(ctx))) return;
    const user = ensureUser(ctx);
    if (!user.address) return ctx.reply('Connect a wallet first — /wallet');

    const nfts = await getAccountNfts(user.address);
    if (!nfts.length) return ctx.replyWithHTML('You hold no NFTs.', backButton('menu:nft'));

    const rows = nfts.slice(0, 15).map((n) => [{
      text: `${short(n.NFTokenID)}  ·  taxon ${n.NFTokenTaxon}`,
      callback_data: `nft:own:${ref(n.NFTokenID)}`,
    }]);
    rows.push([{ text: '‹ Back', callback_data: 'menu:nft' }]);

    await ctx.replyWithHTML(`<b>Your NFTs (${nfts.length})</b>`, { reply_markup: { inline_keyboard: rows } });
  });

  bot.action(/^nft:own:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    let id;
    try { id = derefOrThrow(ctx.match[1]); } catch (e) { return ctx.reply(`❌ ${e.message}`); }
    const bids = await getBuyOffers(id);
    const top = bids.find((b) => b.isXrp);

    await ctx.replyWithHTML(
      [
        `<code>${id}</code>`,
        '',
        top ? `Top bid: <b>${num(top.price, 4)} XRP</b> from ${short(top.owner)}` : 'No bids yet.',
      ].join('\n'),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏷 List for sale', callback_data: `nft:list:${ref(id)}` }],
            top ? [{ text: `✅ Accept ${num(top.price, 2)} XRP`, callback_data: `nft:accept:${ref(top.index)}` }] : [],
            [{ text: '‹ Back', callback_data: 'nft:mine' }],
          ].filter((r) => r.length),
        },
      },
    );
  });

  bot.action(/^nft:list:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requirePrivate(ctx))) return;
    try {
      setState(ctx.from.id, { awaiting: 'nft_list', nftokenId: derefOrThrow(ctx.match[1]) });
      await ctx.reply('List at what price in XRP?');
    } catch (e) { await ctx.reply(`❌ ${e.message}`); }
  });

  bot.action(/^nft:accept:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Accepting…');
    if (!(await requirePrivate(ctx))) return;
    try {
      const wallet = requireWallet(ctx.from.id);
      const res = await acceptBid(wallet, derefOrThrow(ctx.match[1]));
      await ctx.replyWithHTML(`✅ <b>Bid accepted</b>\n\n${res.explorer}`, { disable_web_page_preview: true });
    } catch (e) {
      await ctx.reply(`❌ ${e.message}`);
    }
  });

  /* Text steps -------------------------------------------------------- */

  return {
    showNft,
    isNftId: (t) => NFTOKEN_ID.test(t),

    async handleText(ctx, state) {
      const text = ctx.message.text.trim();

      if (state.awaiting === 'nft_id') {
        clearState(ctx.from.id);
        if (!NFTOKEN_ID.test(text)) { await ctx.reply('That is not a valid NFTokenID.'); return true; }
        await showNft(ctx, text.toUpperCase());
        return true;
      }

      if (state.awaiting === 'nft_bid') {
        clearState(ctx.from.id);
        if (!(await requirePrivate(ctx))) return true;
        const [priceRaw, hoursRaw] = text.split(/\s+/);
        const price = Number(priceRaw);
        if (!(price > 0)) { await ctx.reply('Enter a positive XRP amount.'); return true; }

        try {
          const wallet = requireWallet(ctx.from.id);
          const offers = await getSellOffers(state.nftokenId);
          const owner = offers[0]?.owner;
          if (!owner) throw new Error('Cannot determine the current owner — no open offers to read.');

          const res = await makeBid(wallet, state.nftokenId, owner, price, {
            expiryHours: hoursRaw ? Number(hoursRaw) : undefined,
          });
          await ctx.replyWithHTML(
            `✅ <b>Bid placed at ${num(price, 4)} XRP</b>\n\n0.2 XRP reserved until it fills or you cancel.\n\n${res.explorer}`,
            { disable_web_page_preview: true },
          );
        } catch (e) {
          await ctx.reply(`❌ ${e.message}`);
        }
        return true;
      }

      if (state.awaiting === 'nft_list') {
        clearState(ctx.from.id);
        if (!(await requirePrivate(ctx))) return true;
        const price = Number(text);
        if (!(price > 0)) { await ctx.reply('Enter a positive XRP price.'); return true; }
        try {
          const wallet = requireWallet(ctx.from.id);
          const res = await listNft(wallet, state.nftokenId, price);
          await ctx.replyWithHTML(`✅ <b>Listed at ${num(price, 4)} XRP</b>\n\n${res.explorer}`, { disable_web_page_preview: true });
        } catch (e) {
          await ctx.reply(`❌ ${e.message}`);
        }
        return true;
      }

      return false;
    },
  };
}
