# Telegram gateway ↔ plugin contract

This is the boundary implemented by this gateway and the separately published
`plugin-telegram`. Version 0.1 has one account named `default`.

## Authentication

### Telegram → gateway

`POST /telegram/webhook` requires:

```text
X-Telegram-Bot-Api-Secret-Token: <TELEGRAM_WEBHOOK_SECRET>
```

The same secret is registered with `setWebhook(secret_token=...)`. Missing or
wrong values return 401 and create no rows.

### Gateway ↔ plugin

Both directions use:

```text
signature = hex(HMAC_SHA256(secret, timestamp + "." + rawBodyBytes))
x-tg-timestamp: Unix seconds
x-tg-signature: 64-character hexadecimal signature
```

Verification uses the exact received body bytes, constant-time comparison, and
rejects timestamps more than 300 seconds from current time. Re-serializing JSON
before verification is a contract violation.

Gateway secret: `TG_SHARED_SECRET`.
Expected plugin secret: `LUNA_TELEGRAM_SHARED_SECRET` (or the plugin's
equivalent vault setting). They must be byte-identical.

Cross-language fixture:

```text
secret    shared
timestamp 1000
raw body  {"x":1}
signature 496dee52f246c54d96e5bbd7feee1a8b7515aa706fe9eaa8ffb9f8f77bd48948
```

## Inbound plugin endpoint

The gateway POSTs the normalized envelope to `LUNA_INBOUND_URL`, expected to be:

```text
https://<luna>/api/p/plugin-telegram/inbound
```

Headers are `content-type: application/json`, `x-tg-timestamp`, and
`x-tg-signature`. Any 2xx response is success. The plugin must deduplicate on
`tg_update_id`, because bounded retries can repeat a forward after a server
error. Suggested response:

```json
{"ok":true,"answered":false,"reason":"group_not_addressed"}
```

### Message/edit envelope

```json
{
  "account": "default",
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
- `tg_update_id`: global webhook idempotency key. Never use `tg_msg_id` alone;
  message IDs are only unique inside a chat.
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
policy-silent in v0.1: the plugin must not activate an agent turn for them.

### Reaction envelope

```json
{
  "account": "default",
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

### `GET /health`

No auth. Returns secret-free database, cached bot identity, webhook status,
forwarding status, and last activity. HTTP 503 only when Postgres is unavailable;
missing bot/webhook state is `status: "degraded"` with HTTP 200.

### `GET /stats`

Requires `x-admin-key: <GATEWAY_ADMIN_KEY>`. Returns update/message/chat/sender
counts, 1h/24h windows, media-kind counts, forwarding counts, and runtime state.

### `POST /admin/webhook/setup`

Requires the admin key. Optional body:

```json
{"public_url":"https://gateway.example","drop_pending_updates":false}
```

The URL must be HTTPS. If omitted, `PUBLIC_URL` is used, then the request origin.
The registered URL is always `<origin>/telegram/webhook`. The gateway registers
`message`, `edited_message`, and `message_reaction`, then returns fresh
`getWebhookInfo`.

### `POST /send`

HMAC required.

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

Version 0.1 accepts Telegram file IDs and HTTP(S) URLs, not multipart or base64
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

Invalid input returns 400, failed auth 401, and a Telegram/upstream failure 502.

## Required cross-end assumptions

The plugin must:

1. expose the exact `LUNA_INBOUND_URL`;
2. implement this HMAC scheme and header names over raw body bytes;
3. use the same shared secret;
4. deduplicate inbound work on `tg_update_id`;
5. treat `account` as the literal `default` in v0.1;
6. implement activation and context policy; the gateway captures and annotates
   but does not decide whether Luna answers;
7. treat `channel`, `other`, and sender-null envelopes as capture-only,
   policy-silent context;
8. send only canonical `kind` + `media` JSON file IDs/URLs through
   `/send-media`, and canonical `message_id` through `/react`;
9. import `luna_sdk` only, never Luna internals.
