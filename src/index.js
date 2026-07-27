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

async function main() {
  await getClient();
  console.log(`Connected to XRPL: ${config.xrpl.wsUrl} (${config.xrpl.network})`);

  await bot.telegram.setMyCommands(COMMANDS);

  startAlertLoop(bot);
  await bot.launch();
  console.log(`${brand.name} running — part of ${brand.suite}.`);
}

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
