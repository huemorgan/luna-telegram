import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AccountManager,
  accountMetadata,
  validAccountId,
} from '../src/accounts.js';
import {
  decryptSecret,
  encryptSecret,
  parseEncryptionKey,
} from '../src/crypto.js';
import { loadConfig } from '../src/config.js';

const KEY_HEX = '11'.repeat(32);
const KEY = parseEncryptionKey(KEY_HEX);

test('AES-256-GCM roundtrip is randomized and authenticated', () => {
  const first = encryptSecret(KEY, '123:bot-token');
  const second = encryptSecret(KEY, '123:bot-token');
  assert.notEqual(first.ciphertext, '123:bot-token');
  assert.notDeepEqual(first, second);
  assert.equal(decryptSecret(KEY, first), '123:bot-token');
  assert.throws(
    () => decryptSecret(KEY, { ...first, tag: Buffer.alloc(16).toString('base64') }),
    /authentication failed/,
  );
  assert.throws(() => parseEncryptionKey('too-short'), /must be 32 bytes/);
});

test('account IDs accept tenant slugs and reject traversal or ambiguity', () => {
  for (const value of ['default', 'agent-a', 'a', 'a.b_c-9']) {
    assert.equal(validAccountId(value), true, value);
  }
  for (const value of ['', '-lead', 'trail-', 'UPPER', '../x', 'a/b', 'a'.repeat(65)]) {
    assert.equal(validAccountId(value), false, value);
  }
});

test('hosted config needs no global bot token; legacy default is all-or-none', () => {
  const hosted = loadConfig({
    GATEWAY_ADMIN_KEY: 'admin',
    DATABASE_URL: 'postgres://db',
    TELEGRAM_TOKEN_ENCRYPTION_KEY: KEY_HEX,
    PUBLIC_URL: 'https://gateway.example',
  });
  assert.equal(hosted.legacy, null);

  assert.throws(() => loadConfig({
    GATEWAY_ADMIN_KEY: 'admin',
    DATABASE_URL: 'postgres://db',
    TELEGRAM_TOKEN_ENCRYPTION_KEY: KEY_HEX,
    TELEGRAM_BOT_TOKEN: 'partial',
  }), /requires TELEGRAM_BOT_TOKEN/);

  const legacy = loadConfig({
    GATEWAY_ADMIN_KEY: 'admin',
    DATABASE_URL: 'postgres://db',
    TELEGRAM_TOKEN_ENCRYPTION_KEY: KEY_HEX,
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_WEBHOOK_SECRET: 'edge',
    TG_SHARED_SECRET: 'shared',
    LUNA_INBOUND_URL: 'http://localhost/inbound',
  });
  assert.equal(legacy.legacy.botToken, 'token');
});

class MemoryAccountStore {
  constructor() {
    this.rows = new Map();
  }

  async getAccount(id) {
    return this.rows.get(id) ?? null;
  }

  async findActiveAccountByBotId(botId) {
    return [...this.rows.values()].find(
      (row) => row.enabled && row.bot_id === String(botId),
    ) ?? null;
  }

  async upsertAccount(value) {
    const prior = this.rows.get(value.account_id);
    const now = new Date().toISOString();
    const row = {
      account_id: value.account_id,
      bot_token_ciphertext: value.bot_token.ciphertext,
      bot_token_iv: value.bot_token.iv,
      bot_token_tag: value.bot_token.tag,
      webhook_secret_ciphertext: value.webhook_secret.ciphertext,
      webhook_secret_iv: value.webhook_secret.iv,
      webhook_secret_tag: value.webhook_secret.tag,
      shared_secret_ciphertext: value.shared_secret.ciphertext,
      shared_secret_iv: value.shared_secret.iv,
      shared_secret_tag: value.shared_secret.tag,
      inbound_url: value.inbound_url,
      bot_id: String(value.bot_id),
      bot_username: value.bot_username,
      bot_name: value.bot_name,
      can_join_groups: value.can_join_groups,
      can_read_all_group_messages: value.can_read_all_group_messages,
      supports_inline_queries: value.supports_inline_queries,
      status: value.status,
      enabled: true,
      webhook_info: value.webhook_info,
      last_update_at: prior?.last_update_at ?? null,
      last_forward_at: prior?.last_forward_at ?? null,
      last_error: null,
      disabled_at: null,
      created_at: prior?.created_at ?? now,
      updated_at: now,
    };
    this.rows.set(value.account_id, row);
    return row;
  }

  async updateTelegramState() {}

  async updateAccountInbound(id, inboundUrl) {
    const row = { ...this.rows.get(id), inbound_url: inboundUrl };
    this.rows.set(id, row);
    return row;
  }

  async disableAccount(id, webhook) {
    const row = {
      ...this.rows.get(id),
      enabled: false,
      status: 'disabled',
      webhook_info: webhook,
      disabled_at: new Date().toISOString(),
    };
    this.rows.set(id, row);
    return row;
  }

  async getAccountMetadataRows() {
    return [...this.rows.values()];
  }
}

function fixture() {
  const store = new MemoryAccountStore();
  const calls = [];
  const bots = {
    'token-a': {
      id: 1,
      username: 'bot_a',
      first_name: 'Bot A',
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: true,
    },
    'token-a2': {
      id: 1,
      username: 'bot_a',
      first_name: 'Bot A',
      can_join_groups: true,
      can_read_all_group_messages: true,
      supports_inline_queries: true,
    },
    'token-b': {
      id: 2,
      username: 'bot_b',
      first_name: 'Bot B',
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    },
  };
  const telegramFactory = (token) => ({
    async getMe() {
      calls.push({ token, method: 'getMe' });
      if (!bots[token]) {
        const error = new Error('unauthorized');
        error.status = 401;
        throw error;
      }
      return bots[token];
    },
    async setWebhook(payload) {
      calls.push({ token, method: 'setWebhook', payload });
      return true;
    },
    async getWebhookInfo() {
      const setup = calls.findLast((call) => call.token === token && call.method === 'setWebhook');
      return { url: setup?.payload.url ?? '', pending_update_count: 0 };
    },
    async deleteWebhook(payload) {
      calls.push({ token, method: 'deleteWebhook', payload });
      return true;
    },
    async call(method, payload) {
      calls.push({ token, method, payload });
      return { message_id: 9 };
    },
  });
  const manager = new AccountManager({
    store,
    encryptionKey: KEY,
    publicUrl: 'https://gateway.example/base',
    telegramFactory,
  });
  return { store, calls, manager };
}

test('provision encrypts credentials, registers account path, and redacts metadata', async () => {
  const { store, calls, manager } = fixture();
  const created = await manager.provision({
    account_id: 'agent-a',
    bot_token: 'token-a',
    inbound_url: 'https://luna-a.example/inbound',
  });
  assert.equal(created.created, true);
  assert.match(created.shared_secret, /^[a-f0-9]{64}$/);
  assert.equal(created.account.bot_username, 'bot_a');
  assert.deepEqual(created.account.capabilities, {
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: true,
  });
  assert.equal(
    calls.find((call) => call.method === 'setWebhook').payload.url,
    'https://gateway.example/telegram/webhook/agent-a',
  );
  const row = store.rows.get('agent-a');
  assert.notEqual(row.bot_token_ciphertext, 'token-a');
  assert.equal(manager.decryptRow(row).botToken, 'token-a');
  const serialized = JSON.stringify(created.account);
  assert.doesNotMatch(serialized, /token-a|ciphertext|shared_secret|webhook_secret/);
  assert.deepEqual(accountMetadata(row), created.account);
});

test('idempotent provision recovers existing secret after bot-token proof', async () => {
  const { calls, manager } = fixture();
  const first = await manager.provision({
    account_id: 'agent-a',
    bot_token: 'token-a',
    inbound_url: 'https://luna-a.example/inbound',
  });
  const second = await manager.provision({
    account_id: 'agent-a',
    bot_token: 'token-a',
    inbound_url: 'https://luna-a.example/inbound',
  });
  assert.equal(second.created, false);
  assert.equal(second.rotated, false);
  assert.equal(second.shared_secret, first.shared_secret);
  assert.equal(calls.filter((call) => call.method === 'getMe').length, 2);
  assert.equal(calls.filter((call) => call.method === 'setWebhook').length, 2);
  assert.equal(first.account.account_id, second.account.account_id);
  assert.doesNotMatch(JSON.stringify(await manager.listMetadata()), /shared_secret/);
});

test('PATCH inbound preserves secret; token PATCH rotates it', async () => {
  const { manager } = fixture();
  const created = await manager.provision({
    account_id: 'agent-a',
    bot_token: 'token-a',
    inbound_url: 'https://luna-a.example/inbound',
  });
  const routed = await manager.patch('agent-a', {
    inbound_url: 'https://luna-a.example/new-inbound',
  });
  assert.equal(routed.shared_secret, undefined);
  assert.equal(routed.account.inbound_url, 'https://luna-a.example/new-inbound');

  const rotated = await manager.patch('agent-a', { bot_token: 'token-a2' });
  assert.equal(rotated.rotated, true);
  assert.notEqual(rotated.shared_secret, created.shared_secret);
  assert.equal((await manager.getRuntime('agent-a')).botToken, 'token-a2');
});

test('invalid token, duplicate bot, and missing HTTPS PUBLIC_URL fail safely', async () => {
  const { manager, store } = fixture();
  await assert.rejects(
    () => manager.provision({
      account_id: 'agent-a',
      bot_token: 'invalid',
      inbound_url: 'https://luna-a.example/inbound',
    }),
    (error) => error.status === 400 && error.code === 'invalid_bot_token',
  );
  assert.equal(store.rows.size, 0);

  await manager.provision({
    account_id: 'agent-a',
    bot_token: 'token-a',
    inbound_url: 'https://luna-a.example/inbound',
  });
  await assert.rejects(
    () => manager.provision({
      account_id: 'agent-b',
      bot_token: 'token-a',
      inbound_url: 'https://luna-b.example/inbound',
    }),
    (error) => error.status === 409 && error.code === 'bot_already_connected',
  );

  const noPublic = new AccountManager({
    store: new MemoryAccountStore(),
    encryptionKey: KEY,
    publicUrl: '',
    telegramFactory: () => { throw new Error('must not create client'); },
  });
  await assert.rejects(
    () => noPublic.provision({
      account_id: 'agent-c',
      bot_token: 'token-b',
      inbound_url: 'https://luna-c.example/inbound',
    }),
    (error) => error.status === 503 && error.code === 'public_url_required',
  );

  const mismatchStore = new MemoryAccountStore();
  const mismatch = new AccountManager({
    store: mismatchStore,
    encryptionKey: KEY,
    publicUrl: 'https://gateway.example',
    telegramFactory: () => ({
      async getMe() {
        return { id: 3, username: 'mismatch_bot', first_name: 'Mismatch' };
      },
      async setWebhook() {
        return true;
      },
      async getWebhookInfo() {
        return { url: 'https://wrong.example/webhook' };
      },
    }),
  });
  await assert.rejects(
    () => mismatch.provision({
      account_id: 'agent-c',
      bot_token: 'token-c',
      inbound_url: 'https://luna-c.example/inbound',
    }),
    (error) => error.status === 502 && error.code === 'webhook_verify_failed',
  );
  assert.equal(mismatchStore.rows.size, 0);
});

test('disable deletes webhook, blocks runtime routing, and retains registry row', async () => {
  const { calls, manager, store } = fixture();
  await manager.provision({
    account_id: 'agent-a',
    bot_token: 'token-a',
    inbound_url: 'https://luna-a.example/inbound',
  });
  const disabled = await manager.disable('agent-a');
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.status, 'disabled');
  assert.equal(store.rows.has('agent-a'), true);
  assert.equal(calls.some((call) => call.method === 'deleteWebhook'), true);
  await assert.rejects(
    () => manager.getRuntime('agent-a'),
    (error) => error.status === 404,
  );
});
