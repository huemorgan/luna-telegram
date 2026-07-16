# Telegram gateway ↔ plugin contract

This is the boundary implemented by this gateway and the separately published
`plugin-telegram`. Version 0.2 routes one account per hosted Luna agent slug;
`default` remains a compatibility account only when legacy env is fully set.

## Authentication

### Telegram → gateway

`POST /telegram/webhook/{account_id}` requires that account's:

```text
X-Telegram-Bot-Api-Secret-Token: <TELEGRAM_WEBHOOK_SECRET>
```

The same encrypted per-account secret is registered with
`setWebhook(secret_token=...)`. Missing or wrong values return 401 and create no
rows. `/telegram/webhook` is a compatibility alias for `default`.

### Gateway ↔ plugin

Both directions use:

```text
signature = hex(HMAC_SHA256(secret, timestamp + "." + rawBodyBytes))
x-tg-timestamp: Unix seconds
x-tg-signature: 64-character hexadecimal signature
x-tg-account: Luna agent slug
```

Verification uses the exact received body bytes, constant-time comparison, and
rejects timestamps more than 300 seconds from current time. Re-serializing JSON
before verification is a contract violation.

The gateway resolves `x-tg-account` first and verifies only with that registry
row's encrypted shared secret. Changing the header to another account invalidates
the request. Header omission resolves only `default`; the gateway never scans
all account secrets.

The per-account secret is returned by account create/token rotation and by a
same-token idempotent POST recovery.
Expected plugin vault setting: `plugin_telegram.shared_secret` (or
`LUNA_TELEGRAM_SHARED_SECRET` for self-hosted compatibility). They must be
byte-identical.

Cross-language fixture:

```text
secret    shared
timestamp 1000
raw body  {"x":1}
signature 496dee52f246c54d96e5bbd7feee1a8b7515aa706fe9eaa8ffb9f8f77bd48948
```

## Inbound plugin endpoint

The gateway POSTs the normalized envelope to the account registry's
`inbound_url`, expected to be:

```text
https://<luna>/api/p/plugin-telegram/inbound
```

Headers are `content-type: application/json`, `x-tg-account` (exactly equal to
envelope `account`), `x-tg-timestamp`, and `x-tg-signature`. Any 2xx response is
success. The plugin must deduplicate on `(account, tg_update_id)`, because
bounded retries can repeat a forward after a server error and different bots
can emit the same update ID. Suggested response:

```json
{"ok":true,"answered":false,"reason":"group_not_addressed"}
```

### Message/edit envelope

```json
{
  "account": "agent-slug",
  "event_type": "message",
  "chat_id": "-1001234567890",
  "chat_kind": "dm",
  "chat_name": "Roy or Group title",
  "sender_id": "123456789",
  "sender_name": "Roy",
  "tg_update_id": 123456,
  "tg_msg_id": 42,
  "reply_to_id": 41,
  "ts": "2026-07-16T10:00:00.000Z",
  "kind": "text",
  "body": "hello",
  "edited": false,
  "mentioned_me": false,
  "is_reply_to_me": false,
  "is_command": false,
  "media": null,
  "raw": {}
}
```

Field rules:

- `event_type`: `message`, `edit`, or `reaction`.
- `chat_kind`: `dm`, `group`, `channel`, or `other`.
- `sender_id` and `sender_name` may both be null when Telegram omits both
  `from` and `sender_chat` (notably some channel/service shapes).
- `(account, tg_update_id)`: gateway and plugin idempotency key. Never use
  `tg_msg_id` alone; message IDs are only unique inside a chat.
- `ts`: UTC ISO-8601 from `edit_date` for edits, otherwise Telegram `date`.
- `kind`: `text`, `image`, `animation`, `video`, `voice`, `audio`, `document`,
  `sticker`, `video_note`, `contact`, `location`, `service`, or `other`.
- `body`: text/caption, sticker emoji, service type, contact name, empty string,
  or null according to event type.
- `edited`: true for `edited_message` and `edited_channel_post`.
- `mentioned_me`: a matching `mention` or `text_mention` entity.
- `is_reply_to_me`: the replied-to message's sender is the bot.
- `is_command`: a `bot_command` with no target or targeted to this bot.
- `raw`: complete Telegram update. Plugin code should not require undocumented
  fields from it.

Media is metadata only:

```json
{
  "type": "image",
  "file_id": "telegram-reusable-file-id",
  "file_unique_id": "stable-file-identity",
  "file_size": 1234,
  "mime_type": "image/jpeg",
  "file_name": "photo.jpg",
  "duration": null,
  "width": 1280,
  "height": 720,
  "is_animated": null,
  "is_video": null
}
```

For file media, `media.type` always exactly matches envelope `kind`:
`image`, `animation`, `video`, `voice`, `audio`, `document`, `sticker`, or
`video_note`. Fields not applicable to a media kind are null or absent. For
photos the gateway chooses the largest `photo` size Telegram supplied.

Non-file shapes are explicitly typed:

```json
{"type":"contact","phone_number":"+15550001","first_name":"Ada","last_name":"Lovelace","user_id":123,"vcard":"..."}
{"type":"location","latitude":32.1,"longitude":34.8,"horizontal_accuracy":5}
{"type":"service","service_type":"new_chat_title","value":"New title"}
```

Contact and location fields preserve Telegram's object fields after `type`.
Service `service_type` names the Telegram message field and `value` preserves
that field's value.

`channel` and `other` envelopes, including sender-null envelopes, are still
durably captured and forwarded so the plugin can store context. They are
policy-silent in v0.2: the plugin must not activate an agent turn for them.

### Reaction envelope

```json
{
  "account": "agent-slug",
  "event_type": "reaction",
  "chat_id": "-1001234567890",
  "chat_kind": "group",
  "chat_name": "Builders",
  "sender_id": "123456789",
  "sender_name": "Roy",
  "tg_update_id": 123457,
  "tg_msg_id": 42,
  "reply_to_id": 42,
  "ts": "2026-07-16T10:01:00.000Z",
  "kind": "reaction",
  "body": null,
  "edited": false,
  "mentioned_me": false,
  "is_reply_to_me": false,
  "is_command": false,
  "media": null,
  "reaction_emoji": "❤️",
  "reaction_old": [],
  "reaction_new": [{"type":"emoji","emoji":"❤️"}],
  "raw": {}
}
```

`reaction_new` may be empty for removal or contain custom emoji objects.
`reaction_emoji` is the first standard new emoji, otherwise null. Telegram does
not include the target message author in this update, so the gateway leaves
`is_reply_to_me` false. The plugin should look up `chat_id` + `tg_msg_id` in its
context store to decide whether the reaction targets Luna and whether to answer.

## Gateway endpoints

### Account control plane

All `/accounts` routes require `x-admin-key: <GATEWAY_ADMIN_KEY>`. Account IDs
match `^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$` and luna-service must force
them to the authenticated agent slug.

`POST /accounts`:

```json
{
  "account_id": "agent-slug",
  "bot_token": "123456789:BotFather-token",
  "inbound_url": "https://agent.example/api/p/plugin-telegram/inbound"
}
```

The gateway requires configured HTTPS `PUBLIC_URL`, validates `bot_token` with
`getMe`, rejects a bot already attached to another active account, generates
per-account webhook/HMAC secrets, registers
`<PUBLIC_URL>/telegram/webhook/<account_id>`, verifies `getWebhookInfo`, then
stores the credentials with AES-256-GCM. It returns 201 for a new account and
200 for an idempotent existing account.

New/rotated response:

```json
{
  "ok": true,
  "account": {
    "account_id": "agent-slug",
    "enabled": true,
    "status": "active",
    "inbound_url": "https://agent.example/api/p/plugin-telegram/inbound",
    "bot_id": "123456789",
    "bot_username": "tenant_bot",
    "bot_name": "Tenant Luna",
    "capabilities": {
      "can_join_groups": true,
      "can_read_all_group_messages": false,
      "supports_inline_queries": false
    },
    "webhook": {
      "configured": true,
      "url": "https://gateway.example/telegram/webhook/agent-slug",
      "pending_update_count": 0,
      "last_error_at": null,
      "last_error_message": null,
      "raw": {
        "url": "https://gateway.example/telegram/webhook/agent-slug",
        "pending_update_count": 0
      }
    },
    "created_at": "2026-07-16T12:00:00.000Z",
    "updated_at": "2026-07-16T12:00:00.000Z",
    "disabled_at": null,
    "last_update_at": null,
    "last_forward_at": null,
    "last_error": null
  },
  "shared_secret": "returned-for-create-rotation-or-same-token-recovery"
}
```

An unchanged idempotent POST revalidates `getMe` and webhook registration, then
returns the existing `shared_secret`. This recovery is authorized by both the
admin key and proof of current bot-token possession, allowing luna-service to
retry a failed tenant-vault write. GET/list/stats never expose the secret.
`bot_token`, Telegram webhook secret, encrypted columns, IVs, and tags are never
returned.

`capabilities` comes directly from Bot API `getMe`. It lets luna-service explain
whether the bot can join groups, whether privacy mode permits all group
messages, and whether inline queries are supported.

`webhook.raw` is the secret-free Telegram `getWebhookInfo` object. Normalized
fields are always present: `configured`, `url`, `pending_update_count`,
`last_error_at` (UTC ISO-8601 converted from Telegram `last_error_date`), and
`last_error_message`.

Other routes:

- `GET /accounts` → `{"ok":true,"accounts":[<metadata>...]}`.
- `GET /accounts/{account_id}` → `{"ok":true,"account":<metadata>}`.
- `PATCH /accounts/{account_id}` accepts `{inbound_url}` without rotating
  credentials, or `{bot_token, inbound_url?}` to validate/register and rotate
  both per-account secrets. Only rotation returns `shared_secret`.
- `DELETE /accounts/{account_id}` calls `deleteWebhook`, marks the account
  disabled, rejects future routing, and returns metadata. It never deletes
  account, update, message, or chat history.

Control-plane errors are JSON `{ok:false,error,code?}`: 401 missing/wrong admin
key; 400 invalid ID/input/token; 404 unknown account; 409 bot already connected;
502 Telegram webhook setup/delete/verification failure; 503 missing or non-HTTPS
`PUBLIC_URL`.

### `GET /health`

No auth. Returns secret-free database state, aggregate `{total, enabled}` account
counts, compatibility/default state when present, forwarding status, and last
activity. HTTP 503 only when Postgres is unavailable.

### `GET /stats`

Requires `x-admin-key`. Native luna-service shape:

```json
{
  "ok": true,
  "version": "0.2.0",
  "uptime_s": 123,
  "db": {"ok":true,"latency_ms":2},
  "webhook": {
    "configured": true,
    "pending_update_count": 3,
    "last_error_at": null,
    "last_error_message": null
  },
  "totals": {
    "accounts": 2,
    "active_chats": 5,
    "messages_24h_in": 20,
    "messages_24h_out": 8,
    "forward_failures_24h": 1
  },
  "hourly": [
    {"hour":"2026-07-16T10:00:00.000Z","in":3,"out":2}
  ],
  "accounts": [
    {
      "account_id": "agent-slug",
      "webhook": {"configured":true,"pending_update_count":0},
      "messages_24h_in": 10,
      "messages_24h_out": 4
    }
  ]
}
```

The full account metadata fields documented above are present in each account.
Existing flat fields (`updates`, `updates_1h`, `updates_24h`, `chats`, `senders`,
`forwarded`, `not_forwarded`, `failed`, `kinds_24h`, `state`, and compatibility
`account`) remain.

### `POST /admin/webhook/setup`

Legacy `default` compatibility only. Requires the admin key. Optional body:

```json
{"public_url":"https://gateway.example","drop_pending_updates":false}
```

The URL must be HTTPS. If omitted, `PUBLIC_URL` is used, then the request origin.
The registered URL is always `<origin>/telegram/webhook`. The gateway registers
`message`, `edited_message`, and `message_reaction`, then returns fresh
`getWebhookInfo`.

### `POST /send`

Per-account HMAC and `x-tg-account` required for hosted accounts. Omitting the
account header may authenticate only the legacy `default` account.

```json
{
  "chat_id": "-100123",
  "text": "hello",
  "reply_to": 41,
  "parse_mode": "HTML",
  "reply_markup": {},
  "disable_notification": false,
  "message_thread_id": 7
}
```

Maps to `sendMessage`; `reply_to` becomes
`reply_parameters.message_id`.

### `POST /send-media`

HMAC required.

```json
{
  "chat_id": "-100123",
  "kind": "image",
  "media": "Telegram file_id or HTTPS URL",
  "caption": "optional",
  "parse_mode": "HTML",
  "reply_to": 41,
  "disable_notification": false,
  "message_thread_id": 7
}
```

`kind` and `media` are required canonical fields; `file_id` and `url` field
aliases are rejected. The `media` value itself may be a Telegram file ID or an
HTTP(S) URL. Kind mapping:

- `image`/`photo` → `sendPhoto`
- `animation`/`gif` → `sendAnimation`
- `video` → `sendVideo`
- `voice` → `sendVoice`
- `audio` → `sendAudio`
- `document` → `sendDocument`
- `sticker` → `sendSticker` (no caption)

Version 0.2 accepts Telegram file IDs and HTTP(S) URLs, not multipart or base64
uploads.

### `POST /react`

HMAC required.

```json
{"chat_id":"-100123","message_id":42,"emoji":"❤️","is_big":false}
```

Maps to `setMessageReaction`. Empty `emoji` sends an empty reaction list to
remove the bot's reaction. `message_id` is the required canonical request field;
`tg_msg_id` is not accepted as an alias.

### `POST /typing`

HMAC required.

```json
{"chat_id":"-100123","action":"typing","message_thread_id":7}
```

Maps to `sendChatAction`. `action` defaults to `typing`; all Bot API chat-action
values represented in `gateway/src/telegram.js` are accepted.

Successful outbound response:

```json
{"ok":true,"method":"sendMessage","result":{"message_id":43},"tg_msg_id":43}
```

`/send` and `/send-media` copy Telegram `result.message_id` to top-level
`tg_msg_id` when present, while retaining `method` and the complete `result`.
`/react` and `/typing` never add `tg_msg_id`.

Before returning a successful `/send` or `/send-media` acknowledgement, the
gateway appends the delivery to `telegram_outbound` with account, chat, Telegram
message ID, kind, method, send time, and raw Telegram response metadata.
Reactions and typing actions are not outbound messages and are not recorded
there.

Invalid input returns 400, failed auth 401, and a Telegram/upstream failure 502.

## Gateway configuration

Required hosted env:

- `DATABASE_URL`
- `GATEWAY_ADMIN_KEY`
- `TELEGRAM_TOKEN_ENCRYPTION_KEY` — exactly 32 bytes encoded as 64 hex
  characters or base64
- `PUBLIC_URL` — HTTPS public gateway origin; account provisioning returns 503
  when missing/non-HTTPS

Optional legacy `default` env must be provided all together or not at all:
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TG_SHARED_SECRET`, and
`LUNA_INBOUND_URL`. Optional tuning remains `PORT`, `TELEGRAM_API_BASE`,
`TELEGRAM_API_TIMEOUT_MS`, `TG_FORWARD_ATTEMPTS`, and
`TG_FORWARD_TIMEOUT_MS`.

## Required cross-end assumptions

The plugin must:

1. expose the exact account `inbound_url`;
2. implement this HMAC scheme and header names over raw body bytes;
3. store the account ID and one-time shared secret provisioned by luna-service;
4. send `x-tg-account` on every hosted outbound request;
5. deduplicate inbound work on `(account, tg_update_id)`;
6. implement activation and context policy; the gateway captures and annotates
   but does not decide whether Luna answers;
7. treat `channel`, `other`, and sender-null envelopes as capture-only,
   policy-silent context;
8. send only canonical `kind` + `media` JSON file IDs/URLs through
   `/send-media`, and canonical `message_id` through `/react`;
9. keep all context and outbound operations account-scoped;
10. import `luna_sdk` only, never Luna internals.
