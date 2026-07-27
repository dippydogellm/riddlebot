import { config } from './config.js';
import { brand } from './brand.js';
import { buildBot, COMMANDS } from './bot.js';
import { getClient } from './services/xrpl.js';
import { startAlertLoop } from './handlers/settings.js';

/**
 * Long-running entry point: polling, price alerts, and the copy-trade watcher.
 * This is the mode the bot is designed for. Run it under pm2, Railway, Render,
 * Docker — anything that keeps a process alive.
 */
const bot = buildBot();

/**
 * Telegram hands getUpdates to one client at a time. During a redeploy the
 * old container is often still polling, so the new one gets 409 Conflict.
 * Exiting there turns a normal rollover into a restart loop, so wait for the
 * previous instance to go away instead.
 */
async function launchWithRetry(attempt = 0) {
  try {
    await bot.launch();
  } catch (e) {
    const conflict = e?.response?.error_code === 409 || /409|conflict/i.test(e?.message || '');
    if (!conflict || attempt >= 10) throw e;
    const wait = Math.min(30_000, 2000 * 2 ** attempt);
    console.warn(`Another instance still polling; retrying in ${wait / 1000}s (attempt ${attempt + 1})`);
    await new Promise((r) => setTimeout(r, wait));
    return launchWithRetry(attempt + 1);
  }
}

async function main() {
  await getClient();
  console.log(`Connected to XRPL: ${config.xrpl.wsUrl} (${config.xrpl.network})`);

  await bot.telegram.setMyCommands(COMMANDS);

  startAlertLoop(bot);
  console.log(`${brand.name} running — part of ${brand.suite}.`);
  await launchWithRetry();
}

// Node exits on an unhandled rejection. A single failed Telegram send or a
// hiccup in the alert loop should not take the whole bot down with it.
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
process.on('uncaughtException', (e) => console.error('Uncaught exception:', e));

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    bot.stop(sig);
    process.exit(0);
  });
}
