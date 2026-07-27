# Deploying Riddle Bot

## The short version

**This bot is a long-running process.** It polls Telegram, runs the alert loop,
and writes SQLite to disk. That shape fits a
server, not serverless.

| | Railway / Render / VPS | Vercel |
|---|---|---|
| Commands, buys, sells | ✅ | ✅ (webhook) |
| Price alerts | ✅ | ❌ no background loops |
| Wallet storage | ✅ SQLite on disk | ⚠️ /tmp — **can vanish between requests** |

Deploy the real thing to Railway (or Render, or your VPS with pm2 — see
SETUP.md). Use Vercel only for a demo, or later as the front half of a split
where a worker process does the trading.

---

## Railway (recommended, ~2 minutes)

1. https://railway.app → New Project → Deploy from GitHub → pick `riddlebot`
2. It detects Node and runs `npm start` automatically
3. Variables tab → add:
   ```
   BOT_TOKEN=...
   MASTER_KEY=...          (npm run keygen)
   XRPL_WS_URL=wss://s.altnet.rippletest.net:51233   ← testnet until proven
   FEE_WALLET=...
   ```
4. Settings → add a **Volume** mounted at `/data`, then set `DB_PATH=/data/bot.db`
   — without the volume, every redeploy wipes wallets.

Render is the same shape: Background Worker + a persistent disk.

---

## Vercel (limited webhook mode)

The repo deploys as-is — `api/webhook.js` is the function, `vercel.json` is
already configured.

```bash
npm i -g vercel
vercel --prod
```

Then in the Vercel dashboard set `BOT_TOKEN`, `MASTER_KEY`, and a random
`WEBHOOK_SECRET`, and register the webhook once:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<app>.vercel.app/api/webhook&secret_token=<WEBHOOK_SECRET>"
```

**Know what you're getting:** no copy trading, no alerts, and wallet data in
`/tmp` that Vercel can discard at any time. If a user creates a wallet and the
function cold-starts, their encrypted seed is gone. Do not point real users at
this without first moving `src/services/db.js` to Postgres (Neon works well
with Vercel). Happy to do that conversion when you want it.

To switch back to polling later:

```bash
curl "https://api.telegram.org/bot<TOKEN>/deleteWebhook"
```

Telegram refuses polling while a webhook is registered — if the bot goes
silent after a Vercel experiment, this is why.

---

## One bot token, one deployment

Never run polling and a webhook (or two pollers) against the same token —
Telegram delivers each update once, to whoever asks first, and the bot appears
to "randomly" miss messages. One token, one place, always.
