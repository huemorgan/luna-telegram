import test from 'node:test';
import assert from 'node:assert/strict';
import { MIGRATIONS, SCHEMA, TelegramStore } from '../src/db.js';

function fakePool({ duplicate = false } = {}) {
  const queries = [];
  const client = {
    async query(sql, values) {
      queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), values });
      if (String(sql).includes('INSERT INTO telegram_updates')) {
        return { rowCount: duplicate ? 0 : 1, rows: duplicate ? [] : [{ update_id: 1 }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {
      queries.push({ sql: 'RELEASE' });
    },
  };
  return {
    queries,
    async connect() {
      return client;
    },
  };
}

const update = { update_id: 1, message: { message_id: 2 } };
const envelope = {
  account: 'tenant-a',
  event_type: 'message',
  tg_update_id: 1,
  chat_id: '10',
  chat_kind: 'dm',
  chat_name: 'Roy',
  sender_id: '10',
  sender_name: 'Roy',
  tg_msg_id: 2,
  reply_to_id: null,
  ts: '2026-07-16T10:00:00.000Z',
  kind: 'text',
  body: 'hi',
  edited: false,
  mentioned_me: false,
  is_reply_to_me: false,
  is_command: false,
  media: null,
};

test('schema defines durable update, normalized message, chat, and state tables', () => {
  for (const table of [
    'telegram_updates', 'telegram_messages', 'telegram_chats', 'telegram_state',
    'telegram_accounts', 'telegram_outbound',
  ]) {
    assert.match(SCHEMA, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(SCHEMA, /PRIMARY KEY \(account, update_id\)/);
  assert.match(SCHEMA, /REFERENCES telegram_updates\(account, update_id\)/);
  assert.match(SCHEMA, /idx_tg_messages_chat_ts/);
  assert.match(SCHEMA, /bot_token_ciphertext/);
  assert.match(SCHEMA, /shared_secret_tag/);
  assert.match(SCHEMA, /can_read_all_group_messages/);
  assert.match(SCHEMA, /telegram_outbound[\s\S]*tg_msg_id/);
  assert.match(MIGRATIONS, /ADD COLUMN IF NOT EXISTS can_join_groups/);
  assert.doesNotMatch(`${SCHEMA}\n${MIGRATIONS}`, /DROP (?:TABLE|COLUMN)|DELETE FROM/i);
});

test('capture transaction inserts raw update before normalized rows and commits', async () => {
  const pool = fakePool();
  const store = new TelegramStore(pool);
  assert.equal(await store.captureUpdate('tenant-a', update, 'message', envelope), true);
  assert.equal(pool.queries[0].sql, 'BEGIN');
  assert.match(pool.queries[1].sql, /INSERT INTO telegram_updates/);
  assert.match(pool.queries[2].sql, /INSERT INTO telegram_messages/);
  assert.match(pool.queries[3].sql, /INSERT INTO telegram_chats/);
  assert.match(pool.queries[4].sql, /INSERT INTO telegram_state/);
  assert.match(pool.queries[5].sql, /UPDATE telegram_accounts/);
  assert.equal(pool.queries[6].sql, 'COMMIT');
  assert.equal(pool.queries.at(-1).sql, 'RELEASE');
});

test('duplicate update_id rolls back without a message insert or forwardable row', async () => {
  const pool = fakePool({ duplicate: true });
  const store = new TelegramStore(pool);
  assert.equal(await store.captureUpdate('tenant-a', update, 'message', envelope), false);
  assert.deepEqual(pool.queries.map((query) => query.sql), [
    'BEGIN',
    pool.queries[1].sql,
    'ROLLBACK',
    'RELEASE',
  ]);
  assert.match(pool.queries[1].sql, /ON CONFLICT \(account, update_id\) DO NOTHING/);
  assert.equal(pool.queries.some((query) => /telegram_messages/.test(query.sql)), false);
});
