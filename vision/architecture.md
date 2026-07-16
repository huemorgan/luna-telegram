# Architecture

## Topology

```text
Telegram Bot API
   │ authenticated webhook
   ▼
luna-tg-gateway (Node 20, Express, always on)
   ├── Postgres: encrypted account registry + account-scoped capture
   ├── raw fetch: per-account outbound Bot API methods
   └── exact-byte HMAC POST
          ▼
      plugin-telegram inside Luna
```

The gateway and plugin have separate stores. Gateway Postgres is the transport
source of truth. The plugin keeps the context it needs inside Luna and never
receives gateway database credentials.

## Inbound sequence

1. Telegram calls `POST /telegram/webhook/{account_id}` with that account's
   `X-Telegram-Bot-Api-Secret-Token`.
2. The gateway resolves an enabled registry row, decrypts its edge secret, and
   rejects a missing/wrong token.
3. It identifies the update type and normalizes supported message, edit, media,
   service, or reaction updates.
4. One transaction inserts `telegram_updates`, optionally inserts
   `telegram_messages`, upserts `telegram_chats`, and updates
   `telegram_state`.
5. The transaction commits. Only then can forwarding start.
6. A duplicate `(account, update_id)` is acknowledged with 200 and is not
   forwarded. The same Telegram update ID may exist under another account.
7. A normalized envelope carrying the resolved `account` is serialized once,
   signed with that account's decrypted HMAC secret, and POSTed to that
   account's inbound URL with bounded retries.
8. Forward outcome and the latest error are recorded for health and stats.

Webhook acknowledgement happens after durable capture, before the plugin turn
finishes. This prevents Telegram retries from being tied to agent latency.
There is a small acknowledged-but-not-forwarded crash window in v0.2; the raw
row remains recoverable, but no durable replay worker exists yet.

## Outbound sequence

The plugin signs the exact JSON bytes, sends `x-tg-account`, and calls one
gateway route:

- `/send` → `sendMessage`
- `/send-media` → the native media method for the requested kind
- `/react` → `setMessageReaction`
- `/typing` → `sendChatAction`

The gateway resolves the account before verifying timestamp, skew, and
signature. A signature valid for one account cannot select another account's
bot. The selected token is decrypted only for the Bot API call. Telegram's
result is returned unchanged under `result`, with the documented `tg_msg_id`
acknowledgement for message sends. Successful text/media deliveries are appended
to `telegram_outbound` before HTTP acknowledgement; reactions and typing are not
counted as outbound messages.

## Data model

- `telegram_accounts`: durable route registry keyed by Luna agent slug. Bot
  token, Telegram webhook secret, and plugin HMAC secret are AES-256-GCM
  ciphertext/IV/tag triples. Safe identity, route, webhook, status, error, and
  activity metadata remain queryable, including Bot API `getMe` group/inline
  capabilities.
- `telegram_updates`: append-only raw source, primary key
  `(account, update_id)`, normalized snapshot, forwarding attempts/result.
- `telegram_messages`: one normalized row per supported update, foreign-keyed
  and unique on `(account, update_id)`; indexed by time and
  `(account, chat_id, time)`.
- `telegram_chats`: latest known chat type/name for `(account, chat_id)`.
- `telegram_outbound`: append-only successful `/send` and `/send-media`
  deliveries used for real outbound monitoring.
- `telegram_state`: account-keyed compatibility/runtime snapshots.

`TELEGRAM_TOKEN_ENCRYPTION_KEY` and the gateway admin key remain environment
secrets. Per-account credentials are stored only in authenticated ciphertext
and are never included in health, account-list, account-get, or stats responses.

## Operations and failure behavior

- Database failure before commit returns non-2xx, allowing Telegram to retry.
- Duplicate webhook delivery within one account returns 200 without another
  plugin turn.
- Unknown but valid updates are stored raw and acknowledged without forwarding.
- Plugin failures do not undo durable capture; attempts and the latest error are
  observable.
- `/health` is public and secret-free. `/stats` and `/accounts*` require the
  admin key. Outbound routes require per-account HMAC.
- Account create/rotation requires HTTPS `PUBLIC_URL`, successful `getMe`,
  `setWebhook`, and matching `getWebhookInfo` before an active route is reported.
- DELETE removes the Telegram webhook and disables routing but retains the
  registry row and every captured update/message/chat.
- One Render web instance serves many account paths. luna-service owns tenant
  authentication and forces `account_id` to the authenticated agent slug.
