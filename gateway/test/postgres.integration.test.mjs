import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { TelegramStore } from '../src/db.js';

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL;

function scopedPool(schema) {
  return new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });
}

function envelope(account, updateId) {
  return {
    account,
    event_type: 'message',
    tg_update_id: updateId,
    chat_id: 'chat-1',
    chat_kind: 'dm',
    chat_name: 'Test',
    sender_id: 'sender-1',
    sender_name: 'Sender',
    tg_msg_id: updateId,
    reply_to_id: null,
    ts: new Date().toISOString(),
    kind: 'text',
    body: 'hello',
    edited: false,
    mentioned_me: false,
    is_reply_to_me: false,
    is_command: false,
    media: null,
  };
}

test('Postgres fresh schema, outbound stats, and legacy migration', {
  skip: databaseUrl ? false : 'TEST_DATABASE_URL not set',
}, async () => {
  const suffix = crypto.randomBytes(6).toString('hex');
  const freshSchema = `tg_fresh_${suffix}`;
  const legacySchema = `tg_legacy_${suffix}`;
  const admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA "${freshSchema}"`);
  await admin.query(`CREATE SCHEMA "${legacySchema}"`);

  try {
    const freshPool = scopedPool(freshSchema);
    const fresh = new TelegramStore(freshPool);
    await fresh.init();
    await fresh.upsertAccount({
      account_id: 'agent-a',
      bot_token: { ciphertext: 'token-c', iv: 'token-i', tag: 'token-t' },
      webhook_secret: { ciphertext: 'edge-c', iv: 'edge-i', tag: 'edge-t' },
      shared_secret: { ciphertext: 'hmac-c', iv: 'hmac-i', tag: 'hmac-t' },
      inbound_url: 'https://agent-a.example/inbound',
      bot_id: '1',
      bot_username: 'agent_a_bot',
      bot_name: 'Agent A',
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: true,
      status: 'active',
      webhook_info: {
        url: 'https://gateway.example/telegram/webhook/agent-a',
        pending_update_count: 2,
      },
    });
    assert.equal(
      await fresh.captureUpdate(
        'agent-a',
        { update_id: 77 },
        'message',
        envelope('agent-a', 77),
      ),
      true,
    );
    await fresh.recordOutbound({
      accountId: 'agent-a',
      chatId: 'chat-1',
      tgMsgId: 88,
      kind: 'text',
      method: 'sendMessage',
      response: { message_id: 88 },
    });
    const stats = await fresh.getStats();
    assert.equal(Number(stats.messages_24h_in), 1);
    assert.equal(Number(stats.messages_24h_out), 1);
    assert.equal(Number(stats.active_chats), 1);
    assert.equal(stats.hourly.length, 1);
    assert.equal(stats.accounts[0].can_join_groups, true);
    assert.equal(Number(stats.accounts[0].messages_24h_out), 1);
    await fresh.close();

    const legacyPool = scopedPool(legacySchema);
    await legacyPool.query(`
      CREATE TABLE telegram_updates (
        update_id bigint PRIMARY KEY,
        account text NOT NULL DEFAULT 'default',
        update_type text NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now(),
        raw jsonb NOT NULL,
        normalized jsonb,
        forwarded_at timestamptz,
        forward_attempts integer NOT NULL DEFAULT 0,
        forward_last_error text
      );
      CREATE TABLE telegram_messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account text NOT NULL DEFAULT 'default',
        update_id bigint NOT NULL UNIQUE REFERENCES telegram_updates(update_id),
        event_type text NOT NULL,
        chat_id text NOT NULL,
        chat_kind text NOT NULL,
        chat_name text,
        sender_id text,
        sender_name text,
        tg_msg_id bigint,
        reply_to_id bigint,
        ts timestamptz NOT NULL,
        kind text NOT NULL,
        body text,
        edited boolean NOT NULL DEFAULT false,
        mentioned_me boolean NOT NULL DEFAULT false,
        is_reply_to_me boolean NOT NULL DEFAULT false,
        is_command boolean NOT NULL DEFAULT false,
        media jsonb,
        raw jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE telegram_chats (
        account text NOT NULL DEFAULT 'default',
        chat_id text NOT NULL,
        chat_kind text NOT NULL,
        chat_name text,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(account, chat_id)
      );
      CREATE TABLE telegram_state (
        account text PRIMARY KEY DEFAULT 'default',
        bot_id text,
        bot_username text,
        bot_name text,
        webhook_info jsonb,
        last_update_at timestamptz,
        last_forward_at timestamptz,
        last_forward_error text,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE telegram_accounts (
        account_id text PRIMARY KEY,
        bot_token_ciphertext text NOT NULL,
        bot_token_iv text NOT NULL,
        bot_token_tag text NOT NULL,
        webhook_secret_ciphertext text NOT NULL,
        webhook_secret_iv text NOT NULL,
        webhook_secret_tag text NOT NULL,
        shared_secret_ciphertext text NOT NULL,
        shared_secret_iv text NOT NULL,
        shared_secret_tag text NOT NULL,
        inbound_url text NOT NULL,
        bot_id text NOT NULL,
        bot_username text,
        bot_name text,
        status text NOT NULL DEFAULT 'active',
        enabled boolean NOT NULL DEFAULT true,
        webhook_info jsonb,
        last_update_at timestamptz,
        last_forward_at timestamptz,
        last_error text,
        disabled_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO telegram_updates(update_id, update_type, raw)
      VALUES (77, 'message', '{}');
      INSERT INTO telegram_messages
        (update_id, event_type, chat_id, chat_kind, ts, kind, raw)
      VALUES (77, 'message', 'legacy', 'dm', now(), 'text', '{}');
    `);
    const legacy = new TelegramStore(legacyPool);
    await legacy.init();
    const columns = (await legacyPool.query(`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'telegram_accounts'
    `, [legacySchema])).rows.map((row) => row.column_name);
    assert.ok(columns.includes('can_read_all_group_messages'));
    assert.ok(
      (await legacyPool.query(
        `SELECT to_regclass($1) AS table_name`,
        [`${legacySchema}.telegram_outbound`],
      )).rows[0].table_name,
    );
    assert.equal(
      await legacy.captureUpdate(
        'agent-b',
        { update_id: 77 },
        'message',
        envelope('agent-b', 77),
      ),
      true,
    );
    assert.equal(
      Number((await legacyPool.query(
        `SELECT count(*) AS count FROM telegram_updates WHERE update_id = 77`,
      )).rows[0].count),
      2,
    );
    await legacy.close();
  } finally {
    await admin.query(`DROP SCHEMA "${freshSchema}" CASCADE`);
    await admin.query(`DROP SCHEMA "${legacySchema}" CASCADE`);
    await admin.end();
  }
});
