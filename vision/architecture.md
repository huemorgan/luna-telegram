# Architecture

## Topology

```text
Telegram Bot API
   │ authenticated webhook
   ▼
luna-tg-gateway (Node 20, Express, always on)
   ├── Postgres: raw updates + normalized events + runtime state
   ├── raw fetch: outbound Bot API methods
   └── exact-byte HMAC POST
          ▼
      plugin-telegram inside Luna
```

The gateway and plugin have separate stores. Gateway Postgres is the transport
source of truth. The plugin keeps the context it needs inside Luna and never
receives gateway database credentials.

## Inbound sequence

1. Telegram calls `POST /telegram/webhook` with
   `X-Telegram-Bot-Api-Secret-Token`.
2. The gateway rejects a missing/wrong token before handling the JSON.
3. It identifies the update type and normalizes supported message, edit, media,
   service, or reaction updates.
4. One transaction inserts `telegram_updates`, optionally inserts
   `telegram_messages`, upserts `telegram_chats`, and updates
   `telegram_state`.
5. The transaction commits. Only then can forwarding start.
6. A duplicate `update_id` is acknowledged with 200 and is not forwarded.
7. A normalized envelope is serialized once, signed over those exact bytes, and
   POSTed to the configured Luna plugin route with bounded retries.
8. Forward outcome and the latest error are recorded for health and stats.

Webhook acknowledgement happens after durable capture, before the plugin turn
finishes. This prevents Telegram retries from being tied to agent latency.
There is a small acknowledged-but-not-forwarded crash window in v0.1; the raw
row remains recoverable, but no durable replay worker exists yet.

## Outbound sequence

The plugin signs the exact JSON bytes and calls one gateway route:

- `/send` → `sendMessage`
- `/send-media` → the native media method for the requested kind
- `/react` → `setMessageReaction`
- `/typing` → `sendChatAction`

The gateway verifies timestamp, skew, and signature before parsing the action
into a Bot API payload. Telegram's result is returned unchanged under `result`;
the gateway does not invent delivery identifiers.

## Data model

- `telegram_updates`: append-only raw source, primary key `update_id`, normalized
  snapshot, forwarding attempts/result.
- `telegram_messages`: one normalized row per supported update, foreign-keyed
  and unique on `update_id`; indexed by time and `(account, chat_id, time)`.
- `telegram_chats`: latest known chat type/name for `(account, chat_id)`.
- `telegram_state`: singleton `default` bot identity, webhook information,
  activity, and latest forwarding status.

The bot token and all shared/admin secrets remain environment variables. They
are never stored in Postgres or included in health responses.

## Operations and failure behavior

- Database failure before commit returns non-2xx, allowing Telegram to retry.
- Duplicate webhook delivery returns 200 without another plugin turn.
- Unknown but valid updates are stored raw and acknowledged without forwarding.
- Plugin failures do not undo durable capture; attempts and the latest error are
  observable.
- `/health` is public and secret-free. `/stats` and webhook setup require the
  admin key. Outbound routes require HMAC.
- One Render web instance is used in v0.1. Telegram permits one webhook URL per
  token; horizontal routing and account ownership are deferred to luna-service.
