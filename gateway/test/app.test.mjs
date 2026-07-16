import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { sign } from '../src/hmac.js';

const config = {
  webhookSecret: 'telegram-edge-secret',
  sharedSecret: 'plugin-shared-secret',
  adminKey: 'admin-secret',
  lunaInboundUrl: 'https://luna.invalid/api/p/plugin-telegram/inbound',
  publicUrl: '',
  forwardAttempts: 2,
  forwardTimeoutMs: 1000,
};

class MemoryStore {
  constructor() {
    this.reset();
  }

  reset() {
    this.updates = new Set();
    this.captures = [];
    this.events = [];
    this.forwardResults = [];
    this.state = {
      account: 'default',
      bot_id: '999',
      bot_username: 'LunaBot',
      bot_name: 'Luna',
      webhook_info: { url: 'https://gateway.invalid/telegram/webhook', pending_update_count: 0 },
      last_update_at: null,
      last_forward_at: null,
      last_forward_error: null,
    };
  }

  async ping() {
    return 2;
  }

  async getState() {
    return this.state;
  }

  async getStats() {
    return {
      updates: String(this.captures.length),
      updates_1h: '1',
      updates_24h: '1',
      chats: '1',
      senders: '1',
      forwarded: String(this.forwardResults.filter((x) => x.ok).length),
      not_forwarded: '0',
      failed: '0',
      last_message_at: new Date('2026-07-16T10:00:00Z'),
      kinds_24h: [{ kind: 'text', count: '1' }],
    };
  }

  async captureUpdate(update, type, envelope) {
    this.events.push('capture:start');
    if (this.updates.has(update.update_id)) {
      this.events.push('capture:duplicate');
      return false;
    }
    this.updates.add(update.update_id);
    this.captures.push({ update, type, envelope });
    this.state.last_update_at = new Date().toISOString();
    this.events.push('capture:commit');
    return true;
  }

  async markForwardResult(updateId, result) {
    this.events.push('forward:marked');
    this.forwardResults.push({ updateId, ...result });
  }

  async updateTelegramState(bot, webhook) {
    this.state.bot_id = String(bot.id);
    this.state.bot_username = bot.username;
    this.state.webhook_info = webhook;
  }
}

const store = new MemoryStore();
const telegram = {
  calls: [],
  setup: [],
  async call(method, payload) {
    this.calls.push({ method, payload });
    return method === 'sendChatAction' ? true : { message_id: 900 };
  },
  async setWebhook(payload) {
    this.setup.push(payload);
    return true;
  },
  async getWebhookInfo() {
    return { url: this.setup.at(-1).url, pending_update_count: 0 };
  },
};
let forwardCalls;
const forward = async (envelope) => {
  store.events.push('forward:start');
  forwardCalls.push(envelope);
  return { ok: true, attempts: 1 };
};

const app = createApp({
  config,
  store,
  telegram,
  initialBot: { id: 999, username: 'LunaBot', first_name: 'Luna' },
  forward,
  logger: { error() {} },
});
let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  store.reset();
  telegram.calls = [];
  telegram.setup = [];
  forwardCalls = [];
});

async function post(path, rawBody, headers = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: rawBody,
  });
}

async function drainForwards() {
  await Promise.all([...app.locals.pendingForwards]);
}

function signedHeaders(rawBody, timestamp) {
  const auth = sign(config.sharedSecret, Buffer.from(rawBody), timestamp);
  return {
    'x-tg-timestamp': auth.timestamp,
    'x-tg-signature': auth.signature,
  };
}

const update = {
  update_id: 700,
  message: {
    message_id: 3,
    date: 1_721_125_600,
    chat: { id: 123, type: 'private', first_name: 'Roy' },
    from: { id: 123, first_name: 'Roy' },
    text: 'hello',
  },
};

test('webhook rejects missing or wrong edge secret without capture', async () => {
  let response = await post('/telegram/webhook', JSON.stringify(update));
  assert.equal(response.status, 401);
  response = await post('/telegram/webhook', JSON.stringify(update), {
    'x-telegram-bot-api-secret-token': 'wrong',
  });
  assert.equal(response.status, 401);
  assert.equal(store.captures.length, 0);
});

test('webhook captures before forward and deduplicates update_id', async () => {
  const headers = { 'x-telegram-bot-api-secret-token': config.webhookSecret };
  let response = await post('/telegram/webhook', JSON.stringify(update), headers);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).captured, true);
  await drainForwards();
  assert.deepEqual(store.events.slice(0, 4), [
    'capture:start', 'capture:commit', 'forward:start', 'forward:marked',
  ]);
  assert.equal(forwardCalls.length, 1);
  assert.equal(store.captures[0].envelope.tg_update_id, 700);

  response = await post('/telegram/webhook', JSON.stringify(update), headers);
  assert.deepEqual(await response.json(), { ok: true, duplicate: true });
  await drainForwards();
  assert.equal(store.captures.length, 1);
  assert.equal(forwardCalls.length, 1);
});

test('valid unsupported updates are durably captured but not forwarded', async () => {
  const raw = JSON.stringify({ update_id: 701, callback_query: { id: 'callback' } });
  const response = await post('/telegram/webhook', raw, {
    'x-telegram-bot-api-secret-token': config.webhookSecret,
  });
  assert.deepEqual(await response.json(), { ok: true, captured: true, normalized: false });
  assert.equal(store.captures[0].type, 'callback_query');
  assert.equal(store.captures[0].envelope, null);
  assert.equal(forwardCalls.length, 0);
});

test('signed endpoints reject unsigned, stale, and non-exact signatures', async () => {
  const body = '{ "chat_id": 123, "text": "hello" }\n';
  let response = await post('/send', body);
  assert.equal(response.status, 401);

  response = await post('/send', body, signedHeaders(body, '1000'));
  assert.equal(response.status, 401);

  const compact = JSON.stringify({ chat_id: 123, text: 'hello' });
  response = await post('/send', body, signedHeaders(compact));
  assert.equal(response.status, 401);
  assert.equal(telegram.calls.length, 0);
});

test('signed outbound endpoints call native Telegram methods', async () => {
  for (const [path, payload, method] of [
    ['/send', { chat_id: 1, text: 'hello', reply_to: 2 }, 'sendMessage'],
    ['/send-media', { chat_id: 1, kind: 'image', media: 'FILE' }, 'sendPhoto'],
    ['/react', { chat_id: 1, message_id: 2, emoji: '👍' }, 'setMessageReaction'],
    ['/typing', { chat_id: 1, action: 'typing' }, 'sendChatAction'],
  ]) {
    const body = JSON.stringify(payload);
    const response = await post(path, body, signedHeaders(body));
    assert.equal(response.status, 200, path);
    const data = await response.json();
    assert.equal(data.method, method);
    assert.deepEqual(data.result, method === 'sendChatAction' ? true : { message_id: 900 });
    if (path === '/send' || path === '/send-media') {
      assert.equal(data.tg_msg_id, 900);
    } else {
      assert.equal(Object.hasOwn(data, 'tg_msg_id'), false);
    }
  }
  assert.deepEqual(telegram.calls.map((call) => call.method), [
    'sendMessage', 'sendPhoto', 'setMessageReaction', 'sendChatAction',
  ]);
});

test('outbound routes reject non-canonical field aliases', async () => {
  for (const [path, payload] of [
    ['/send-media', { chat_id: 1, kind: 'image', file_id: 'FILE' }],
    ['/send-media', { chat_id: 1, kind: 'image', url: 'https://example.test/x.jpg' }],
    ['/react', { chat_id: 1, tg_msg_id: 2, emoji: '👍' }],
  ]) {
    const body = JSON.stringify(payload);
    const response = await post(path, body, signedHeaders(body));
    assert.equal(response.status, 400, path);
  }
  assert.equal(telegram.calls.length, 0);
});

test('health is public while stats and webhook setup require admin key', async () => {
  let response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.db.ok, true);
  assert.equal(health.bot.username, 'LunaBot');
  assert.equal(health.webhook.url, 'https://gateway.invalid/telegram/webhook');

  response = await fetch(`${baseUrl}/stats`);
  assert.equal(response.status, 401);
  response = await fetch(`${baseUrl}/stats`, { headers: { 'x-admin-key': config.adminKey } });
  assert.equal(response.status, 200);
  const stats = await response.json();
  assert.equal(stats.updates, 0);
  assert.deepEqual(stats.kinds_24h, [{ kind: 'text', count: 1 }]);

  response = await post('/admin/webhook/setup', JSON.stringify({
    public_url: 'https://tg.example/some/path',
  }));
  assert.equal(response.status, 401);
  response = await post('/admin/webhook/setup', JSON.stringify({
    public_url: 'https://tg.example/some/path',
  }), { 'x-admin-key': config.adminKey });
  assert.equal(response.status, 200);
  assert.equal(telegram.setup[0].url, 'https://tg.example/telegram/webhook');
  assert.equal(telegram.setup[0].secret_token, config.webhookSecret);
  assert.deepEqual(telegram.setup[0].allowed_updates, [
    'message', 'edited_message', 'message_reaction',
  ]);
});
