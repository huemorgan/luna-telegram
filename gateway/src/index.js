import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool, TelegramStore } from './db.js';
import { TelegramClient } from './telegram.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const store = new TelegramStore(pool);
const telegram = new TelegramClient({
  token: config.botToken,
  apiBase: config.telegramApiBase,
  timeoutMs: config.telegramTimeoutMs,
});

await store.init();

const [botResult, webhookResult] = await Promise.allSettled([
  telegram.getMe(),
  telegram.getWebhookInfo(),
]);
const bot = botResult.status === 'fulfilled' ? botResult.value : null;
const webhook = webhookResult.status === 'fulfilled' ? webhookResult.value : null;
if (botResult.status === 'rejected') {
  console.error('[telegram] getMe failed:', botResult.reason.message);
}
if (webhookResult.status === 'rejected') {
  console.error('[telegram] getWebhookInfo failed:', webhookResult.reason.message);
}
await store.updateTelegramState(bot, webhook);

const app = createApp({ config, store, telegram, initialBot: bot });
const server = app.listen(config.port, () => {
  console.log(`[gateway] listening on :${config.port} as @${bot?.username ?? 'unknown'}`);
});

async function shutdown(signal) {
  console.log(`[gateway] ${signal}, shutting down`);
  server.close(async () => {
    await store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
