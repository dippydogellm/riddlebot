/**
 * Vercel serverless entry — webhook mode.
 *
 * ⚠️ READ DEPLOY.md BEFORE USING THIS IN ANGER.
 *
 * What works here: commands, menus, token cards, manual buys and sells.
 * What cannot work on serverless, by design of the platform:
 *
 *   - COPY TRADING  — needs a persistent XRPL WebSocket subscription.
 *                     A function that dies after each request can't hold one.
 *   - PRICE ALERTS  — same problem: no background loop.
 *   - SQLITE        — Vercel's filesystem is ephemeral. We fall back to /tmp,
 *                     which survives warm invocations only. Wallets, follows
 *                     and history CAN VANISH BETWEEN REQUESTS. Never point
 *                     real users at this without moving the DB to Postgres.
 *
 * The real deployment is `npm start` on Railway / Render / a VPS.
 * This entry exists so the repo deploys cleanly to Vercel for demos and for
 * a future split where Vercel serves the UI and a worker does the trading.
 *
 * Setup:
 *   1. Deploy, note the URL.
 *   2. Set env vars in Vercel: BOT_TOKEN, MASTER_KEY, WEBHOOK_SECRET (random string).
 *   3. Register the webhook once:
 *      curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<app>.vercel.app/api/webhook&secret_token=<WEBHOOK_SECRET>"
 *   To go back to polling: curl "https://api.telegram.org/bot<TOKEN>/deleteWebhook"
 *      (Telegram refuses polling while a webhook is registered.)
 */

if (!process.env.DB_PATH) process.env.DB_PATH = '/tmp/riddlebot.db';

let botPromise = null;

async function getBot() {
  if (!botPromise) {
    botPromise = (async () => {
      const { buildBot } = await import('../src/bot.js');
      return buildBot();
    })();
  }
  return botPromise;
}

export default async function handler(req, res) {
  // The long-running polling deployment is authoritative. Telegram hands each
  // update to whoever asks first, so a live webhook here would silently steal
  // updates from it and the bot would appear to "randomly" miss messages.
  // Opt in only when this is the sole deployment for the token.
  if (process.env.ENABLE_WEBHOOK !== '1') {
    return res.status(503).json({
      ok: false,
      disabled: true,
      reason: 'Polling deployment is authoritative. Set ENABLE_WEBHOOK=1 to serve webhook mode from here instead.',
    });
  }

  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, service: 'riddle-bot webhook', mode: 'limited — see DEPLOY.md' });
  }

  // Telegram echoes the secret back on every delivery; reject anything else.
  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    return res.status(401).json({ ok: false });
  }

  try {
    const bot = await getBot();
    await bot.handleUpdate(req.body);
  } catch (e) {
    // Always 200 — a non-200 makes Telegram retry the same update in a loop.
    console.error('[webhook]', e);
  }
  return res.status(200).json({ ok: true });
}
