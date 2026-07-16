import pg from 'pg';

const { Pool } = pg;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id           bigint PRIMARY KEY,
  account             text NOT NULL DEFAULT 'default',
  update_type         text NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  raw                 jsonb NOT NULL,
  normalized          jsonb,
  forwarded_at        timestamptz,
  forward_attempts    integer NOT NULL DEFAULT 0,
  forward_last_error  text
);
CREATE INDEX IF NOT EXISTS idx_tg_updates_received
  ON telegram_updates (received_at DESC);

CREATE TABLE IF NOT EXISTS telegram_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account         text NOT NULL DEFAULT 'default',
  update_id       bigint NOT NULL UNIQUE REFERENCES telegram_updates(update_id),
  event_type      text NOT NULL,
  chat_id         text NOT NULL,
  chat_kind       text NOT NULL,
  chat_name       text,
  sender_id       text,
  sender_name     text,
  tg_msg_id       bigint,
  reply_to_id     bigint,
  ts              timestamptz NOT NULL,
  kind            text NOT NULL,
  body            text,
  edited          boolean NOT NULL DEFAULT false,
  mentioned_me    boolean NOT NULL DEFAULT false,
  is_reply_to_me  boolean NOT NULL DEFAULT false,
  is_command      boolean NOT NULL DEFAULT false,
  media           jsonb,
  raw             jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tg_messages_ts
  ON telegram_messages (ts DESC);
CREATE INDEX IF NOT EXISTS idx_tg_messages_chat_ts
  ON telegram_messages (account, chat_id, ts DESC);

CREATE TABLE IF NOT EXISTS telegram_chats (
  account       text NOT NULL DEFAULT 'default',
  chat_id       text NOT NULL,
  chat_kind     text NOT NULL,
  chat_name     text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account, chat_id)
);

CREATE TABLE IF NOT EXISTS telegram_state (
  account              text PRIMARY KEY DEFAULT 'default',
  bot_id               text,
  bot_username         text,
  bot_name             text,
  webhook_info         jsonb,
  last_update_at       timestamptz,
  last_forward_at      timestamptz,
  last_forward_error   text,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
`;

export function createPool(databaseUrl) {
  return new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('render.com') ? { rejectUnauthorized: false } : undefined,
  });
}

export class TelegramStore {
  constructor(pool) {
    this.pool = pool;
  }

  async init() {
    await this.pool.query(SCHEMA);
    await this.pool.query(
      `INSERT INTO telegram_state (account) VALUES ('default')
       ON CONFLICT (account) DO NOTHING`,
    );
  }

  async close() {
    await this.pool.end();
  }

  async ping() {
    const started = Date.now();
    await this.pool.query('SELECT 1');
    return Date.now() - started;
  }

  async captureUpdate(update, type, envelope) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO telegram_updates (update_id, account, update_type, raw, normalized)
         VALUES ($1, 'default', $2, $3::jsonb, $4::jsonb)
         ON CONFLICT (update_id) DO NOTHING
         RETURNING update_id`,
        [
          update.update_id,
          type,
          JSON.stringify(update),
          envelope ? JSON.stringify(envelope) : null,
        ],
      );
      if (!inserted.rowCount) {
        await client.query('ROLLBACK');
        return false;
      }

      if (envelope) {
        await client.query(
          `INSERT INTO telegram_messages
             (account, update_id, event_type, chat_id, chat_kind, chat_name,
              sender_id, sender_name, tg_msg_id, reply_to_id, ts, kind, body,
              edited, mentioned_me, is_reply_to_me, is_command, media, raw)
           VALUES
             ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
              $18::jsonb,$19::jsonb)`,
          [
            envelope.account, envelope.tg_update_id, envelope.event_type,
            envelope.chat_id, envelope.chat_kind, envelope.chat_name,
            envelope.sender_id, envelope.sender_name, envelope.tg_msg_id,
            envelope.reply_to_id, envelope.ts, envelope.kind, envelope.body,
            envelope.edited, envelope.mentioned_me, envelope.is_reply_to_me,
            envelope.is_command, envelope.media ? JSON.stringify(envelope.media) : null,
            JSON.stringify(update),
          ],
        );
        await client.query(
          `INSERT INTO telegram_chats
             (account, chat_id, chat_kind, chat_name, updated_at)
           VALUES ($1,$2,$3,$4,now())
           ON CONFLICT (account, chat_id) DO UPDATE
             SET chat_kind = EXCLUDED.chat_kind,
                 chat_name = EXCLUDED.chat_name,
                 updated_at = now()`,
          [envelope.account, envelope.chat_id, envelope.chat_kind, envelope.chat_name],
        );
      }

      await client.query(
        `UPDATE telegram_state
            SET last_update_at = now(), updated_at = now()
          WHERE account = 'default'`,
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async markForwardResult(updateId, { ok, attempts, error }) {
    await this.pool.query(
      `UPDATE telegram_updates
          SET forward_attempts = $2,
              forwarded_at = CASE WHEN $3 THEN now() ELSE forwarded_at END,
              forward_last_error = $4
        WHERE update_id = $1`,
      [updateId, attempts, ok, error ?? null],
    );
    await this.pool.query(
      `UPDATE telegram_state
          SET last_forward_at = CASE WHEN $1 THEN now() ELSE last_forward_at END,
              last_forward_error = $2,
              updated_at = now()
        WHERE account = 'default'`,
      [ok, error ?? null],
    );
  }

  async updateTelegramState(bot, webhook) {
    await this.pool.query(
      `UPDATE telegram_state
          SET bot_id = COALESCE($1, bot_id),
              bot_username = COALESCE($2, bot_username),
              bot_name = COALESCE($3, bot_name),
              webhook_info = COALESCE($4::jsonb, webhook_info),
              updated_at = now()
        WHERE account = 'default'`,
      [
        bot?.id != null ? String(bot.id) : null,
        bot?.username ?? null,
        bot ? [bot.first_name, bot.last_name].filter(Boolean).join(' ') : null,
        webhook ? JSON.stringify(webhook) : null,
      ],
    );
  }

  async getState() {
    const result = await this.pool.query(
      `SELECT * FROM telegram_state WHERE account = 'default'`,
    );
    return result.rows[0] ?? null;
  }

  async getStats() {
    const [counts, types, forwards] = await Promise.all([
      this.pool.query(`
        SELECT count(*) AS updates,
               count(*) FILTER (WHERE received_at > now() - interval '1 hour') AS updates_1h,
               count(*) FILTER (WHERE received_at > now() - interval '24 hours') AS updates_24h,
               count(DISTINCT chat_id) AS chats,
               count(DISTINCT sender_id) AS senders,
               max(ts) AS last_message_at
          FROM telegram_messages`),
      this.pool.query(`
        SELECT kind, count(*) AS count
          FROM telegram_messages
         WHERE ts > now() - interval '24 hours'
         GROUP BY kind ORDER BY count DESC`),
      this.pool.query(`
        SELECT count(*) FILTER (WHERE forwarded_at IS NOT NULL) AS forwarded,
               count(*) FILTER (WHERE forwarded_at IS NULL AND normalized IS NOT NULL) AS not_forwarded,
               count(*) FILTER (WHERE forward_last_error IS NOT NULL) AS failed
          FROM telegram_updates`),
    ]);
    return {
      ...counts.rows[0],
      ...forwards.rows[0],
      kinds_24h: types.rows,
    };
  }
}
