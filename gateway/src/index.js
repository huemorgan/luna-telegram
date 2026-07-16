import { createApp } from './app.js';
import { AccountManager } from './accounts.js';
import { loadConfig } from './config.js';
import { createPool, TelegramStore } from './db.js';
import { TelegramClient } from './telegram.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const store = new TelegramStore(pool);
const telegramFactory = (token) => new TelegramClient({
  token,
  apiBase: config.telegramApiBase,
  timeoutMs: config.telegramTimeoutMs,
});

await store.init();
const accountManager = new AccountManager({
  store,
  encryptionKey: config.encryptionKey,
  publicUrl: config.publicUrl,
  telegramFactory,
});

if (config.legacy) {
  const client = telegramFactory(config.legacy.botToken);
  try {
    const [bot, webhook] = await Promise.all([
      client.getMe(),
      client.getWebhookInfo(),
    ]);
    await accountManager.seedLegacy({
      ...config.legacy,
      bot,
      webhook,
    });
  } catch (error) {
    console.error('[telegram] legacy default initialization failed:', error.message);
  }
}

const app = createApp({ config, store, accountManager });
const server = app.listen(config.port, () => {
  console.log(`[gateway] listening on :${config.port}`);
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
