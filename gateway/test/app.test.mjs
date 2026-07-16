import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildHealth, createApp } from '../src/app.js';
import { sign } from '../src/hmac.js';

const config = {
  adminKey: 'admin-secret',
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
    this.outbound = [];
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

  async getAccountCounts() {
    return { total: 2, enabled: 2 };
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
      messages_24h_in: '3',
      messages_24h_out: '2',
      active_chats: '2',
      forward_failures_24h: '1',
      last_message_at: new Date('2026-07-16T10:00:00Z'),
      kinds_24h: [{ kind: 'text', count: '1' }],
      hourly: [{
        hour: new Date('2026-07-16T10:00:00Z'),
        in: '3',
        out: '2',
      }],
    };
  }

  async captureUpdate(accountId, update, type, envelope) {
    this.events.push('capture:start');
    const key = `${accountId}:${update.update_id}`;
    if (this.updates.has(key)) {
      this.events.push('capture:duplicate');
      return false;
    }
    this.updates.add(key);
    this.captures.push({ accountId, update, type, envelope });
    this.state.last_update_at = new Date().toISOString();
    this.events.push('capture:commit');
    return true;
  }

  async markForwardResult(accountId, updateId, result) {
    this.events.push('forward:marked');
    this.forwardResults.push({ accountId, updateId, ...result });
  }

  async recordOutbound(row) {
    this.outbound.push(row);
    return { id: 'out-1', sent_at: new Date() };
  }

  async updateTelegramState(_accountId, bot, webhook) {
    this.state.bot_id = String(bot.id);
    this.state.bot_username = bot.username;
    this.state.webhook_info = webhook;
  }
}

const store = new MemoryStore();
function fakeClient(accountId) {
  return {
    calls: [],
    setup: [],
    async call(method, payload) {
      this.calls.push({ accountId, method, payload });
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
}

const telegram = fakeClient('default');
const tenantTelegram = fakeClient('agent-a');
const accountRows = [
  {
    account_id: 'default', enabled: true, status: 'active',
    inbound_url: 'https://luna.invalid/api/p/plugin-telegram/inbound',
    bot_id: '999', bot_username: 'LunaBot', bot_name: 'Luna',
    capabilities: {
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    },
    webhook: {
      configured: true,
      url: 'https://gateway.invalid/telegram/webhook',
      pending_update_count: 1,
      last_error_at: null,
      last_error_message: null,
      raw: { url: 'https://gateway.invalid/telegram/webhook', pending_update_count: 1 },
    },
    messages_24h_in: 2,
    messages_24h_out: 1,
  },
  {
    account_id: 'agent-a', enabled: true, status: 'active',
    inbound_url: 'https://agent-a.invalid/inbound',
    bot_id: '1000', bot_username: 'AgentABot', bot_name: 'Agent A',
    capabilities: {
      can_join_groups: true,
      can_read_all_group_messages: true,
      supports_inline_queries: true,
    },
    webhook: {
      configured: true,
      url: 'https://gateway.invalid/telegram/webhook/agent-a',
      pending_update_count: 2,
      last_error_at: '2026-07-16T09:00:00.000Z',
      last_error_message: 'connection reset',
      raw: {
        url: 'https://gateway.invalid/telegram/webhook/agent-a',
        pending_update_count: 2,
        last_error_date: 1784192400,
        last_error_message: 'connection reset',
      },
    },
    messages_24h_in: 1,
    messages_24h_out: 1,
  },
];
const runtimes = {
  default: {
    account: accountRows[0],
    webhookSecret: 'telegram-edge-secret',
    sharedSecret: 'plugin-shared-secret',
    client: telegram,
    bot: { id: 999, username: 'LunaBot', first_name: 'Luna' },
  },
  'agent-a': {
    account: accountRows[1],
    webhookSecret: 'agent-a-edge-secret',
    sharedSecret: 'agent-a-shared-secret',
    client: tenantTelegram,
    bot: { id: 1000, username: 'AgentABot', first_name: 'Agent A' },
  },
};
const accountManager = {
  async getRuntime(accountId) {
    const runtime = runtimes[accountId];
    if (!runtime || !runtime.account.enabled) {
      const error = new Error('account not found');
      error.status = 404;
      throw error;
    }
    return runtime;
  },
  async listMetadata() {
    return accountRows;
  },
  async getMetadata(accountId) {
    const row = accountRows.find((account) => account.account_id === accountId);
    if (!row) {
      const error = new Error('account not found');
      error.status = 404;
      throw error;
    }
    return row;
  },
  async provision(body) {
    return {
      created: true,
      account: { ...accountRows[1], account_id: body.account_id },
      shared_secret: 'one-time-shared-secret',
    };
  },
  async patch(accountId, body) {
    return {
      account: {
        ...accountRows.find((account) => account.account_id === accountId),
        inbound_url: body.inbound_url,
      },
    };
  },
  async disable(accountId) {
    return {
      ...accountRows.find((account) => account.account_id === accountId),
      enabled: false,
      status: 'disabled',
    };
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
  accountManager,
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
  tenantTelegram.calls = [];
  tenantTelegram.setup = [];
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

function signedHeaders(rawBody, timestamp, secret = 'plugin-shared-secret') {
  const auth = sign(secret, Buffer.from(rawBody), timestamp);
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

test('hosted health is healthy without a legacy default bot', () => {
  const health = buildHealth({
    db: { ok: true, latency_ms: 1 },
    state: null,
    accounts: { total: 2, enabled: 2 },
  });
  assert.equal(health.status, 'ok');
  assert.equal(health.bot, null);
});

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
  const headers = { 'x-telegram-bot-api-secret-token': 'telegram-edge-secret' };
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

test('same update_id is isolated by account webhook path and edge secret', async () => {
  const raw = JSON.stringify(update);
  let response = await post('/telegram/webhook', raw, {
    'x-telegram-bot-api-secret-token': 'telegram-edge-secret',
  });
  assert.equal(response.status, 200);
  response = await post('/telegram/webhook/agent-a', raw, {
    'x-telegram-bot-api-secret-token': 'agent-a-edge-secret',
  });
  assert.equal(response.status, 200);
  await drainForwards();
  assert.deepEqual(
    store.captures.map((capture) => capture.accountId),
    ['default', 'agent-a'],
  );
  assert.deepEqual(
    forwardCalls.map((envelope) => envelope.account),
    ['default', 'agent-a'],
  );

  response = await post('/telegram/webhook/agent-a', raw, {
    'x-telegram-bot-api-secret-token': 'telegram-edge-secret',
  });
  assert.equal(response.status, 401);
  assert.equal(store.captures.length, 2);
});

test('valid unsupported updates are durably captured but not forwarded', async () => {
  const raw = JSON.stringify({ update_id: 701, callback_query: { id: 'callback' } });
  const response = await post('/telegram/webhook', raw, {
    'x-telegram-bot-api-secret-token': 'telegram-edge-secret',
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

test('x-tg-account binds HMAC verification and Bot API client selection', async () => {
  const body = JSON.stringify({ chat_id: 1, text: 'tenant message' });
  let response = await post('/send', body, {
    ...signedHeaders(body, undefined, 'agent-a-shared-secret'),
    'x-tg-account': 'agent-a',
  });
  assert.equal(response.status, 200);
  assert.equal(tenantTelegram.calls.length, 1);
  assert.equal(telegram.calls.length, 0);

  response = await post('/send', body, {
    ...signedHeaders(body),
    'x-tg-account': 'agent-a',
  });
  assert.equal(response.status, 401);
  assert.equal(tenantTelegram.calls.length, 1);
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
  assert.deepEqual(
    store.outbound.map((row) => ({
      accountId: row.accountId,
      chatId: row.chatId,
      tgMsgId: row.tgMsgId,
      kind: row.kind,
      method: row.method,
    })),
    [
      {
        accountId: 'default',
        chatId: '1',
        tgMsgId: 900,
        kind: 'text',
        method: 'sendMessage',
      },
      {
        accountId: 'default',
        chatId: '1',
        tgMsgId: 900,
        kind: 'image',
        method: 'sendPhoto',
      },
    ],
  );
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

test('account control-plane routes require admin auth and shape secret-safe responses', async () => {
  const createBody = JSON.stringify({
    account_id: 'agent-new',
    bot_token: 'submitted-token',
    inbound_url: 'https://agent-new.invalid/inbound',
  });
  let response = await post('/accounts', createBody);
  assert.equal(response.status, 401);

  response = await post('/accounts', createBody, { 'x-admin-key': config.adminKey });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.account.account_id, 'agent-new');
  assert.equal(created.shared_secret, 'one-time-shared-secret');
  assert.doesNotMatch(JSON.stringify(created.account), /submitted-token|ciphertext/);

  response = await fetch(`${baseUrl}/accounts`, {
    headers: { 'x-admin-key': config.adminKey },
  });
  const listed = await response.json();
  assert.equal(listed.accounts.length, 2);
  assert.equal(Object.hasOwn(listed, 'shared_secret'), false);

  response = await fetch(`${baseUrl}/accounts/agent-a`, {
    headers: { 'x-admin-key': config.adminKey },
  });
  assert.equal((await response.json()).account.bot_username, 'AgentABot');

  const patchBody = JSON.stringify({ inbound_url: 'https://new.invalid/inbound' });
  response = await fetch(`${baseUrl}/accounts/agent-a`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-admin-key': config.adminKey },
    body: patchBody,
  });
  const patched = await response.json();
  assert.equal(patched.account.inbound_url, 'https://new.invalid/inbound');
  assert.equal(Object.hasOwn(patched, 'shared_secret'), false);

  response = await fetch(`${baseUrl}/accounts/agent-a`, {
    method: 'DELETE',
    headers: { 'x-admin-key': config.adminKey },
  });
  assert.equal((await response.json()).account.enabled, false);
});

test('health is public while stats and webhook setup require admin key', async () => {
  let response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.db.ok, true);
  assert.equal(health.bot.username, 'LunaBot');
  assert.equal(health.webhook.url, 'https://gateway.invalid/telegram/webhook');
  assert.deepEqual(health.accounts, { total: 2, enabled: 2 });

  response = await fetch(`${baseUrl}/stats`);
  assert.equal(response.status, 401);
  response = await fetch(`${baseUrl}/stats`, { headers: { 'x-admin-key': config.adminKey } });
  assert.equal(response.status, 200);
  const stats = await response.json();
  assert.equal(stats.version, '0.2.0');
  assert.equal(typeof stats.uptime_s, 'number');
  assert.deepEqual(stats.db, { ok: true, latency_ms: 2 });
  assert.deepEqual(stats.webhook, {
    configured: true,
    pending_update_count: 3,
    last_error_at: '2026-07-16T09:00:00.000Z',
    last_error_message: 'connection reset',
  });
  assert.deepEqual(stats.totals, {
    accounts: 2,
    active_chats: 2,
    messages_24h_in: 3,
    messages_24h_out: 2,
    forward_failures_24h: 1,
  });
  assert.deepEqual(stats.hourly, [{
    hour: '2026-07-16T10:00:00.000Z',
    in: 3,
    out: 2,
  }]);
  assert.equal(stats.updates, 0);
  assert.deepEqual(stats.kinds_24h, [{ kind: 'text', count: 1 }]);
  assert.equal(stats.accounts.length, 2);
  assert.equal(stats.accounts[1].messages_24h_out, 1);
  assert.equal(stats.accounts[1].webhook.configured, true);
  assert.equal(stats.accounts[1].capabilities.can_read_all_group_messages, true);

  response = await post('/admin/webhook/setup', JSON.stringify({
    public_url: 'https://tg.example/some/path',
  }));
  assert.equal(response.status, 401);
  response = await post('/admin/webhook/setup', JSON.stringify({
    public_url: 'https://tg.example/some/path',
  }), { 'x-admin-key': config.adminKey });
  assert.equal(response.status, 200);
  assert.equal(telegram.setup[0].url, 'https://tg.example/telegram/webhook');
  assert.equal(telegram.setup[0].secret_token, 'telegram-edge-secret');
  assert.deepEqual(telegram.setup[0].allowed_updates, [
    'message', 'edited_message', 'message_reaction',
  ]);
});
