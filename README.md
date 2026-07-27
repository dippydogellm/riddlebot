# Riddle Buy Bot

<img src="assets/rdl-logo.jpg" width="120" align="right" alt="Riddle Labs" />

Telegram bot for buying and selling **tokens and NFTs** on the XRP Ledger.
Part of the **Riddle Labs** suite.

---

## Branding

`src/brand.js` holds the name, tagline, site link and palette — change it there
and it propagates to every screen. Set `BRAND_SITE` / `BRAND_SUPPORT` in `.env`.

Assets in `assets/`:

| File | Use |
|---|---|
| `rdl-logo.jpg` | Sent with `/start` and `/about`. The first send is cached as a Telegram `file_id`, so later sends are references, not uploads. |
| `rdl-avatar-512.png` | Upload to @BotFather → *Edit Bot* → *Edit Botpic* |
| `rdl-mark-white.png` | Transparent-background mark for anywhere you need it over a non-black surface |

`rdl-avatar-512.png` is upscaled from the 225px source, so it's slightly soft at
full size. If you still have the vector from the Riddle Hood build, drop the SVG
in and re-export — it'll be noticeably crisper on retina screens.

### @BotFather setup

```
/setname          Riddle Bot
/setdescription   Buy and sell every XRPL token and NFT from Telegram. By Riddle Labs.
/setabouttext     XRPL trading bot — tokens, NFTs, live pricing. riddlelabs.io
/setuserpic       (upload assets/rdl-avatar-512.png)
```

---

## Setup

**Full walkthrough: [SETUP.md](SETUP.md)** — BotFather, testnet funding, pm2, backups.

Short version:

```bash
npm install
cp .env.example .env
npm run keygen        # paste the output into MASTER_KEY
# add BOT_TOKEN from @BotFather
npm start
```

**Test on testnet first.** `.env.example` ships pointed at
`wss://s.altnet.rippletest.net:51233`. Fund a test wallet from
https://xrpl.org/xrp-testnet-faucet.html, run every flow end to end, *then*
switch `XRPL_WS_URL` to `wss://xrplcluster.com`.

---

## Commands

| | |
|---|---|
| `/start`, `/menu` | Main menu |
| `/about` | Bot and suite info |
| `/wallet` | Balance, withdraw, export seed |
| `/history` | Last 15 trades |

Paste a `CODE.issuer` pair (e.g. `SOLO.rsoLo2S1kiGeCcn6hCUXVrCpGMWLrRrLZz`) or a
64-character NFTokenID into the chat to jump straight to a trade card.

---

## What it does

**Tokens** — search or browse by 24h volume, see price / volume / holders / a
0–100 risk score, then one-tap buy at 5/10/25/100 XRP or a custom size. Sell by
percentage of holdings. Trustlines open automatically on first buy.

**NFTs** — browse top collections and live listings, buy the floor in one tap,
place bids with optional expiry, list your own NFTs, accept incoming bids.

**Alerts** — `CODE.issuer above 0.15` pings you when the book crosses that price,
with a buy button attached.

---

## How the swaps work

XRPL has no AMM router to call — a token swap is a **cross-currency payment to
yourself**, routed through the native DEX order book.

```
Payment
  Account     = you
  Destination = you
  SendMax     = 10 XRP          ← exact spend
  Amount      = 1050 TOKEN      ← ceiling
  DeliverMin  = 1018 TOKEN      ← quote × (1 − slippage)
  Flags       = tfPartialPayment
```

`tfPartialPayment` is what makes the fill flexible, and `DeliverMin` is the only
thing stopping it from delivering a single drop. **Never send a partial payment
without `DeliverMin`** — that combination is the classic XRPL footgun.

Quotes come from walking `book_offers` directly, not from a cached price, so the
number you're shown is the number the ledger will actually fill against.

NFT purchases are `NFTokenAcceptOffer` against the cheapest open sell offer,
filtered to XRP-denominated listings with no `Destination` lock (a locked
listing is reserved for a specific buyer and will fail for anyone else).

---

## Custody — read this before going live

The bot holds encrypted seeds. Seeds are AES-256-GCM encrypted with a
scrypt-derived key bound to `MASTER_KEY` *and* the user's Telegram ID, so a
leaked database alone is not enough — but **you are running a custodial service**,
with the legal and operational weight that carries.

Before mainnet:

- Put `MASTER_KEY` in a secrets manager, not on the box next to `bot.db`
- Encrypt the disk holding `data/bot.db` and back up both, separately
- Rate-limit per user — nothing currently stops a loop of buy transactions
- Add a daily spend cap per account
- Consider Xaman (XUMM) deep-link signing instead, which moves custody back to
  the user and removes most of this risk surface

`RESERVE_BUFFER_XRP` keeps 2 XRP untouchable so accounts stay above the base
reserve. Each trustline and each open NFT offer locks a further 0.2 XRP.

---

## Revenue

`FEE_BPS` + `FEE_WALLET` take a cut of filled volume as a separate XRP payment
after each fill. 100 bps = 1%. It's charged post-fill and failures are logged but
non-fatal, so a fee problem never costs the user their trade.

---

## Layout

```
assets/                 logo and avatar
src/
  index.js              bot wiring, free-text router
  config.js             env
  brand.js              name, palette, logo sending
  services/
    xrpl.js             client, currency codes, order-book quotes, submit
    tokens.js           buy / sell / trustlines
    nfts.js             offers, floor sweep, bids, listings
    wallet.js           create / import / export
    crypto.js           seed encryption
    api.js              xrpl.to REST wrapper
    db.js               SQLite
    refs.js             short handles for callback_data
    session.js          multi-step prompt state
  handlers/             wallet, tokens, nfts, settings
  ui/index.js           keyboards, formatting
```

Market data via the [xrpl.to API](https://xrpl.to/docs) (free tier: 10 req/sec —
they ask for a visible link back). All transaction building, signing and
submission goes straight to a rippled node via `xrpl.js`, so trading keeps
working even if the data provider is down.
