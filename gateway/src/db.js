import pg from 'pg';

const { Pool } = pg;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS telegram_updates (
  account             text NOT NULL DEFAULT 'default',
  update_id           bigint NOT NULL,
  update_type         text NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  raw                 jsonb NOT NULL,
  normalized          jsonb,
  forwarded_at        timestamptz,
  forward_attempts    integer NOT NULL DEFAULT 0,
  forward_last_error  text,
  PRIMARY KEY (account, update_id)
);
CREATE INDEX IF NOT EXISTS idx_tg_updates_received
  ON telegram_updates (received_at DESC);

CREATE TABLE IF NOT EXISTS telegram_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account         text NOT NULL DEFAULT 'default',
  update_id       bigint NOT NULL,
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
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account, update_id),
  FOREIGN KEY (account, update_id)
    REFERENCES telegram_updates(account, update_id)
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

CREATE TABLE IF NOT EXISTS telegram_accounts (
  account_id                    text PRIMARY KEY,
  bot_token_ciphertext          text NOT NULL,
  bot_token_iv                  text NOT NULL,
  bot_token_tag                 text NOT NULL,
  webhook_secret_ciphertext     text NOT NULL,
  webhook_secret_iv             text NOT NULL,
  webhook_secret_tag            text NOT NULL,
  shared_secret_ciphertext      text NOT NULL,
  shared_secret_iv              text NOT NULL,
  shared_secret_tag             text NOT NULL,
  inbound_url                   text NOT NULL,
  bot_id                        text NOT NULL,
  bot_username                  text,
  bot_name                      text,
  can_join_groups               boolean,
  can_read_all_group_messages   boolean,
  supports_inline_queries       boolean,
  status                        text NOT NULL DEFAULT 'active',
  enabled                       boolean NOT NULL DEFAULT true,
  webhook_info                  jsonb,
  last_update_at                timestamptz,
  last_forward_at               timestamptz,
  last_error                    text,
  disabled_at                   timestamptz,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_accounts_active_bot
  ON telegram_accounts (bot_id) WHERE enabled;

CREATE TABLE IF NOT EXISTS telegram_outbound (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account       text NOT NULL,
  chat_id       text NOT NULL,
  tg_msg_id     bigint NOT NULL,
  kind          text NOT NULL,
  method        text NOT NULL,
  sent_at       timestamptz NOT NULL DEFAULT now(),
  response      jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tg_outbound_account_sent
  ON telegram_outbound (account, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_tg_outbound_chat_sent
  ON telegram_outbound (account, chat_id, sent_at DESC);
`;

export const MIGRATIONS = `
ALTER TABLE telegram_accounts
  ADD COLUMN IF NOT EXISTS can_join_groups boolean;
ALTER TABLE telegram_accounts
  ADD COLUMN IF NOT EXISTS can_read_all_group_messages boolean;
ALTER TABLE telegram_accounts
  ADD COLUMN IF NOT EXISTS supports_inline_queries boolean;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'telegram_updates'::regclass
       AND conname = 'telegram_updates_pkey'
       AND pg_get_constraintdef(oid) = 'PRIMARY KEY (update_id)'
  ) THEN
    ALTER TABLE telegram_messages
      DROP CONSTRAINT IF EXISTS telegram_messages_update_id_fkey;
    ALTER TABLE telegram_messages
      DROP CONSTRAINT IF EXISTS telegram_messages_update_id_key;
    ALTER TABLE telegram_updates
      DROP CONSTRAINT telegram_updates_pkey;
    ALTER TABLE telegram_updates
      ADD CONSTRAINT telegram_updates_pkey PRIMARY KEY (account, update_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'telegram_messages'::regclass
       AND contype = 'u'
       AND pg_get_constraintdef(oid) = 'UNIQUE (account, update_id)'
  ) THEN
    ALTER TABLE telegram_messages
      ADD CONSTRAINT telegram_messages_account_update_key UNIQUE (account, update_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'telegram_messages'::regclass
       AND contype = 'f'
       AND pg_get_constraintdef(oid)
         LIKE 'FOREIGN KEY (account, update_id) REFERENCES telegram_updates(account, update_id)%'
  ) THEN
    ALTER TABLE telegram_messages
      ADD CONSTRAINT telegram_messages_account_update_fkey
      FOREIGN KEY (account, update_id)
      REFERENCES telegram_updates(account, update_id);
  END IF;
END $$;
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
    await this.pool.query(MIGRATIONS);
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

  async captureUpdate(accountId, update, type, envelope) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO telegram_updates (account, update_id, update_type, raw, normalized)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
         ON CONFLICT (account, update_id) DO NOTHING
         RETURNING update_id`,
        [
          accountId,
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
            accountId, envelope.tg_update_id, envelope.event_type,
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
          [accountId, envelope.chat_id, envelope.chat_kind, envelope.chat_name],
        );
      }

      await client.query(
        `INSERT INTO telegram_state (account, last_update_at, updated_at)
         VALUES ($1, now(), now())
         ON CONFLICT (account) DO UPDATE
            SET last_update_at = now(), updated_at = now()
        `,
        [accountId],
      );
      await client.query(
        `UPDATE telegram_accounts
            SET last_update_at = now(), updated_at = now()
          WHERE account_id = $1`,
        [accountId],
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

  async markForwardResult(accountId, updateId, { ok, attempts, error }) {
    await this.pool.query(
      `UPDATE telegram_updates
          SET forward_attempts = $3,
              forwarded_at = CASE WHEN $4 THEN now() ELSE forwarded_at END,
              forward_last_error = $5
        WHERE account = $1 AND update_id = $2`,
      [accountId, updateId, attempts, ok, error ?? null],
    );
    await this.pool.query(
      `INSERT INTO telegram_state
         (account, last_forward_at, last_forward_error, updated_at)
       VALUES ($1, CASE WHEN $2 THEN now() ELSE NULL END, $3, now())
       ON CONFLICT (account) DO UPDATE
          SET last_forward_at = CASE WHEN $2 THEN now() ELSE telegram_state.last_forward_at END,
              last_forward_error = $3,
              updated_at = now()
      `,
      [accountId, ok, error ?? null],
    );
    await this.pool.query(
      `UPDATE telegram_accounts
          SET last_forward_at = CASE WHEN $2 THEN now() ELSE last_forward_at END,
              last_error = $3,
              updated_at = now()
        WHERE account_id = $1`,
      [accountId, ok, error ?? null],
    );
  }

  async updateTelegramState(accountId, bot, webhook) {
    await this.pool.query(
      `INSERT INTO telegram_state
         (account, bot_id, bot_username, bot_name, webhook_info, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,now())
       ON CONFLICT (account) DO UPDATE
          SET bot_id = COALESCE($2, telegram_state.bot_id),
              bot_username = COALESCE($3, telegram_state.bot_username),
              bot_name = COALESCE($4, telegram_state.bot_name),
              webhook_info = COALESCE($5::jsonb, telegram_state.webhook_info),
              updated_at = now()
      `,
      [
        accountId,
        bot?.id != null ? String(bot.id) : null,
        bot?.username ?? null,
        bot ? [bot.first_name, bot.last_name].filter(Boolean).join(' ') : null,
        webhook ? JSON.stringify(webhook) : null,
      ],
    );
  }

  async getState(accountId = 'default') {
    const result = await this.pool.query(
      `SELECT * FROM telegram_state WHERE account = $1`,
      [accountId],
    );
    return result.rows[0] ?? null;
  }

  async getAccount(accountId) {
    const result = await this.pool.query(
      `SELECT * FROM telegram_accounts WHERE account_id = $1`,
      [accountId],
    );
    return result.rows[0] ?? null;
  }

  async listAccounts({ includeDisabled = true } = {}) {
    const where = includeDisabled ? '' : 'WHERE enabled';
    return (await this.pool.query(
      `SELECT * FROM telegram_accounts ${where} ORDER BY account_id`,
    )).rows;
  }

  async findActiveAccountByBotId(botId) {
    const result = await this.pool.query(
      `SELECT * FROM telegram_accounts
        WHERE bot_id = $1 AND enabled
        LIMIT 1`,
      [String(botId)],
    );
    return result.rows[0] ?? null;
  }

  async upsertAccount(account) {
    const result = await this.pool.query(
      `INSERT INTO telegram_accounts
         (account_id,
          bot_token_ciphertext, bot_token_iv, bot_token_tag,
          webhook_secret_ciphertext, webhook_secret_iv, webhook_secret_tag,
          shared_secret_ciphertext, shared_secret_iv, shared_secret_tag,
          inbound_url, bot_id, bot_username, bot_name,
          can_join_groups, can_read_all_group_messages, supports_inline_queries,
          status, enabled,
          webhook_info, last_error, disabled_at, updated_at)
       VALUES
         ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,true,
          $19::jsonb,NULL,NULL,now())
       ON CONFLICT (account_id) DO UPDATE SET
          bot_token_ciphertext = EXCLUDED.bot_token_ciphertext,
          bot_token_iv = EXCLUDED.bot_token_iv,
          bot_token_tag = EXCLUDED.bot_token_tag,
          webhook_secret_ciphertext = EXCLUDED.webhook_secret_ciphertext,
          webhook_secret_iv = EXCLUDED.webhook_secret_iv,
          webhook_secret_tag = EXCLUDED.webhook_secret_tag,
          shared_secret_ciphertext = EXCLUDED.shared_secret_ciphertext,
          shared_secret_iv = EXCLUDED.shared_secret_iv,
          shared_secret_tag = EXCLUDED.shared_secret_tag,
          inbound_url = EXCLUDED.inbound_url,
          bot_id = EXCLUDED.bot_id,
          bot_username = EXCLUDED.bot_username,
          bot_name = EXCLUDED.bot_name,
          can_join_groups = EXCLUDED.can_join_groups,
          can_read_all_group_messages = EXCLUDED.can_read_all_group_messages,
          supports_inline_queries = EXCLUDED.supports_inline_queries,
          status = EXCLUDED.status,
          enabled = true,
          webhook_info = EXCLUDED.webhook_info,
          last_error = NULL,
          disabled_at = NULL,
          updated_at = now()
       RETURNING *`,
      [
        account.account_id,
        account.bot_token.ciphertext, account.bot_token.iv, account.bot_token.tag,
        account.webhook_secret.ciphertext, account.webhook_secret.iv,
        account.webhook_secret.tag,
        account.shared_secret.ciphertext, account.shared_secret.iv,
        account.shared_secret.tag,
        account.inbound_url, String(account.bot_id), account.bot_username ?? null,
        account.bot_name ?? null,
        account.can_join_groups ?? null,
        account.can_read_all_group_messages ?? null,
        account.supports_inline_queries ?? null,
        account.status ?? 'active',
        account.webhook_info ? JSON.stringify(account.webhook_info) : null,
      ],
    );
    return result.rows[0];
  }

  async updateAccountInbound(accountId, inboundUrl) {
    const result = await this.pool.query(
      `UPDATE telegram_accounts
          SET inbound_url = $2, updated_at = now()
        WHERE account_id = $1
        RETURNING *`,
      [accountId, inboundUrl],
    );
    return result.rows[0] ?? null;
  }

  async disableAccount(accountId, webhookInfo = null) {
    const result = await this.pool.query(
      `UPDATE telegram_accounts
          SET enabled = false,
              status = 'disabled',
              webhook_info = COALESCE($2::jsonb, webhook_info),
              disabled_at = now(),
              updated_at = now()
        WHERE account_id = $1
        RETURNING *`,
      [accountId, webhookInfo ? JSON.stringify(webhookInfo) : null],
    );
    return result.rows[0] ?? null;
  }

  async getAccountMetadataRows() {
    return (await this.pool.query(`
      SELECT a.account_id, a.inbound_url, a.bot_id, a.bot_username, a.bot_name,
             a.can_join_groups, a.can_read_all_group_messages,
             a.supports_inline_queries,
             a.status, a.enabled, a.webhook_info, a.last_update_at,
             a.last_forward_at, a.last_error, a.disabled_at,
             a.created_at, a.updated_at,
             COALESCE(m.messages_24h_in, 0) AS messages_24h_in,
             COALESCE(o.messages_24h_out, 0) AS messages_24h_out,
             COALESCE(m.chats_24h, 0) AS chats_24h,
             COALESCE(u.forward_failures, 0) AS forward_failures
        FROM telegram_accounts a
        LEFT JOIN (
          SELECT account, count(*) AS messages_24h_in,
                 count(DISTINCT chat_id) AS chats_24h
            FROM telegram_messages
           WHERE ts > now() - interval '24 hours'
           GROUP BY account
        ) m ON m.account = a.account_id
        LEFT JOIN (
          SELECT account, count(*) AS messages_24h_out
            FROM telegram_outbound
           WHERE sent_at > now() - interval '24 hours'
           GROUP BY account
        ) o ON o.account = a.account_id
        LEFT JOIN (
          SELECT account,
                 count(*) FILTER (WHERE forward_last_error IS NOT NULL)
                   AS forward_failures
            FROM telegram_updates
           WHERE received_at > now() - interval '24 hours'
           GROUP BY account
        ) u ON u.account = a.account_id
       ORDER BY a.account_id
    `)).rows;
  }

  async getAccountCounts() {
    const result = await this.pool.query(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE enabled) AS enabled
         FROM telegram_accounts`,
    );
    return {
      total: Number(result.rows[0]?.total ?? 0),
      enabled: Number(result.rows[0]?.enabled ?? 0),
    };
  }

  async recordOutbound({
    accountId,
    chatId,
    tgMsgId,
    kind,
    method,
    response,
  }) {
    const result = await this.pool.query(
      `INSERT INTO telegram_outbound
         (account, chat_id, tg_msg_id, kind, method, response)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       RETURNING id, sent_at`,
      [
        accountId,
        String(chatId),
        tgMsgId,
        kind,
        method,
        JSON.stringify(response),
      ],
    );
    return result.rows[0];
  }

  async getStats() {
    const [
      counts,
      types,
      forwards,
      outbound,
      activeChats,
      hourly,
      accounts,
    ] = await Promise.all([
      this.pool.query(`
        SELECT count(*) AS updates,
               count(*) FILTER (WHERE ts > now() - interval '1 hour') AS updates_1h,
               count(*) FILTER (WHERE ts > now() - interval '24 hours') AS updates_24h,
               count(*) FILTER (WHERE ts > now() - interval '24 hours') AS messages_24h_in,
               count(DISTINCT (account, chat_id)) AS chats,
               count(DISTINCT (account, sender_id)) FILTER (WHERE sender_id IS NOT NULL) AS senders,
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
               count(*) FILTER (WHERE forward_last_error IS NOT NULL) AS failed,
               count(*) FILTER (
                 WHERE forward_last_error IS NOT NULL
                   AND received_at > now() - interval '24 hours'
               ) AS forward_failures_24h
          FROM telegram_updates`),
      this.pool.query(`
        SELECT count(*) FILTER (
                 WHERE sent_at > now() - interval '24 hours'
               ) AS messages_24h_out
          FROM telegram_outbound`),
      this.pool.query(`
        SELECT count(DISTINCT (account, chat_id)) AS active_chats
          FROM (
            SELECT account, chat_id
              FROM telegram_messages
             WHERE ts > now() - interval '24 hours'
            UNION ALL
            SELECT account, chat_id
              FROM telegram_outbound
             WHERE sent_at > now() - interval '24 hours'
          ) activity`),
      this.pool.query(`
        SELECT hour,
               sum(messages_in)::bigint AS "in",
               sum(messages_out)::bigint AS "out"
          FROM (
            SELECT date_trunc('hour', ts) AS hour,
                   count(*) AS messages_in,
                   0::bigint AS messages_out
              FROM telegram_messages
             WHERE ts > now() - interval '24 hours'
             GROUP BY 1
            UNION ALL
            SELECT date_trunc('hour', sent_at) AS hour,
                   0::bigint AS messages_in,
                   count(*) AS messages_out
              FROM telegram_outbound
             WHERE sent_at > now() - interval '24 hours'
             GROUP BY 1
          ) buckets
         GROUP BY hour
         ORDER BY hour`),
      this.getAccountMetadataRows(),
    ]);
    return {
      ...counts.rows[0],
      ...forwards.rows[0],
      ...outbound.rows[0],
      ...activeChats.rows[0],
      kinds_24h: types.rows,
      hourly: hourly.rows,
      accounts,
    };
  }
}
