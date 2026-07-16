# 001 — Telegram Gateway

**Produces version:** gateway 0.1.0

## Context

Luna has a WhatsApp transport, but no Telegram transport. Telegram's supported
Bot API differs from WhatsApp Web: the Luna identity is a bot created through
@BotFather, not a mirror of the owner's personal Telegram account. The bot can
receive all direct messages sent to it and group messages allowed by Telegram's
privacy mode. It cannot read arbitrary owner DMs or chats where it is absent.

This repository will provide the separate, durable transport service that stays
online while Luna restarts or sleeps. The Luna-facing plugin is developed and
published separately in `huemorgan/plugin-telegram`.

## Decisions

1. Use the official Telegram Bot API, not an MTProto "userbot". This avoids
   account-ban and terms-of-service risk.
2. Use HTTPS webhooks in production. `getUpdates` long polling is reserved for
   local diagnostics because Telegram allows only one delivery mode at a time.
3. Keep a gateway even though Telegram can call Luna directly. The gateway
   persists every update before forwarding, owns the bot token, absorbs Luna
   downtime, and gives proactive sends a stable endpoint.
4. Use `update_id` as the capture idempotency key. Telegram `message_id` is only
   unique inside a chat.
5. Verify Telegram with `X-Telegram-Bot-Api-Secret-Token`; sign all
   gateway↔plugin traffic with the same timestamped HMAC pattern as WhatsApp.

## Architecture impact

- `ADD`: official Telegram Bot API transport and its platform limits →
  `vision/vision.md` § Platform model.
- `ADD`: webhook gateway, durable capture store, and retryable Luna forwarding →
  `vision/architecture.md` § Topology and reliability.
- `ADD`: Telegram-specific HMAC wire contract →
  `vision/contract.md`.
- `ADD`: Render web service and Postgres blueprint →
  `render.yaml`.

## Both-ends checklist

This crosses the gateway↔plugin boundary.

- Gateway: `gateway/src/webhook.js`, `gateway/src/inbound.js`,
  `gateway/src/hmac.js`, `gateway/src/index.js`.
- Plugin: `plugin_telegram/routes.py`, `plugin_telegram/client.py`,
  `plugin_telegram/hmac.py`.
- Contract: `vision/contract.md`.
- Node and Python HMAC fixtures must produce identical signatures.

## Concerns review

- Capture first: insert every accepted Telegram update before any forwarding or
  activation decision.
- One webhook owner: one bot token has one configured webhook URL.
- Signed hops: Telegram secret header at the public edge; HMAC internally.
- Cross-chat memory: plugin keeps an owner-local context copy across Telegram
  chats with chat/sender attribution.
- Judgment: DMs activate; groups activate only on mention, command, or reply to
  Luna. Other delivered group messages are stored but not answered.
- Native output: text, photos, video/GIF animation, voice, audio, documents,
  stickers, replies, typing actions, and reactions use native Bot API methods.
- Platform safety: no userbot or personal-account automation.
- Plugin boundary: only `luna_sdk`, never `luna.*`.

## Goals

1. Receive Telegram updates through an authenticated webhook.
2. Durably and idempotently capture messages, edits, and reactions before
   forwarding normalized events to Luna.
3. Forward events to `plugin-telegram` and support native outbound delivery.
4. Expose health, webhook status/setup, and HMAC-protected send APIs.
5. Deploy one gateway and Postgres database on Render in Oregon.
6. Preserve enough raw update data to add new Telegram event types later.

## Non-goals

- Reading the owner's unrelated personal Telegram chats.
- MTProto user-account automation.
- Multi-tenant token management in v0.1.0; luna-service owns that later phase.
- Channels, payments, inline-query experiences, moderation, and forum-topic
  administration in the first release.
- Guaranteed replay to Luna after long outages; the initial release stores all
  updates and makes bounded forwarding retries.

## Approach

### 1. Repository and contract

- Create public GitHub repository `huemorgan/luna-telegram`.
- Write `vision/vision.md`, `vision/architecture.md`, `vision/contract.md`, and
  `vision/codemap.md`.
- Add `plugin-telegram` as a submodule after its first push.

### 2. Gateway

- Node 20 + Express + `pg`; use the Bot API over `fetch` with no Telegram SDK.
- `POST /telegram/webhook`: validate secret header, insert raw update, normalize,
  then forward to Luna.
- `GET /health`: DB, webhook, bot identity, forwarding, and activity status.
- `POST /admin/webhook/setup`: admin-key protected registration using the
  request origin or an explicit public URL.
- HMAC endpoints: `/send`, `/send-media`, `/react`, `/typing`.
- Store updates, normalized messages, chats, and singleton runtime state in
  Postgres. Never store the bot token in the database or logs.

### 3. Reliability

- Unique `update_id`; duplicate webhook deliveries return 200 without a second
  forward.
- Return 200 only after durable capture. Telegram retries non-2xx webhook
  responses; malformed/unauthenticated requests fail without storage.
- Bound Luna-forward attempts and expose the latest failure in `/health`.
- Preserve raw JSON and indexes by chat/time for context and operations.

### 4. Render

- Blueprint creates `luna-tg-gateway` and `luna-tg-db`, plan `starter`, region
  `oregon`, one instance.
- Required dashboard secrets:
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TG_SHARED_SECRET`,
  `GATEWAY_ADMIN_KEY`, and `LUNA_INBOUND_URL`.
- No persistent disk is required; Telegram bot identity is token-based.
- After deploy, call webhook setup and verify with `getWebhookInfo`.

### 5. Tests and verification

- Pure normalization tests for DMs, groups, mentions, replies, media, reactions,
  edits, service messages, and duplicate updates.
- HMAC and edge-auth tests.
- Database idempotency and capture-before-forward tests.
- Outbound Bot API payload tests.
- Live BotFather bot → Render webhook → Luna plugin → Telegram reply walkthrough.

## Data / API contract

Normalized inbound envelope:

```json
{
  "account": "default",
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
  "mentioned_me": false,
  "is_reply_to_me": false,
  "media": null,
  "raw": {}
}
```

The complete schema, headers, endpoints, response semantics, media structure,
and reaction event shape live in `vision/contract.md` and must be implemented on
both ends.

## Risks

- BotFather token is a hard deployment prerequisite. Mitigation: scaffold,
  deploy, and verify health first; block webhook activation until the token is
  supplied.
- Privacy mode can make group capture appear broken. Mitigation: onboarding
  explicitly explains `/setprivacy`, admin rights, and re-adding the bot.
- Telegram may redeliver updates. Mitigation: unique `update_id`.
- Luna can be down while Telegram continues. Mitigation: durable capture and
  observable forwarding errors; durable replay is a follow-up.
- Files can exceed Bot API download limits. Mitigation: preserve `file_id` and
  metadata; reject unsupported downloads clearly.

## Acceptance criteria

- [ ] Both GitHub repositories exist with correct visibility and remotes.
- [ ] Every valid webhook update is stored before forwarding.
- [ ] Duplicate `update_id` does not produce a duplicate agent turn.
- [ ] DM and group activation behavior matches the stated policy.
- [ ] Text, reply, typing, image, animated GIF/video, voice, document, sticker,
      and reaction paths have contract tests.
- [ ] Gateway and plugin HMAC fixtures match.
- [ ] Gateway and Postgres are live on Render.
- [ ] `getWebhookInfo` reports the deployed webhook with zero configuration
      errors.
- [ ] A real Telegram DM receives a Luna reply.
- [ ] A real group mention receives a reply and ordinary chatter stays silent.
- [ ] Execution report records test and live evidence.

## Verification

```bash
cd gateway && npm ci && npm test
cd ../plugin-telegram && python -m pytest -q
curl -fsS https://<gateway>.onrender.com/health
curl -fsS -H "x-admin-key: <key>" \
  -X POST https://<gateway>.onrender.com/admin/webhook/setup
```

Then inspect `getWebhookInfo`, send one DM, send one ordinary group message, and
send one @mention in a real Telegram group. Confirm capture, activation, native
reply, and no duplicate turn.
