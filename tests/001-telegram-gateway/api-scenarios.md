# Telegram gateway end-to-end scenarios

These scenarios require a disposable Postgres database, a mock Telegram Bot API,
and a mock Luna plugin receiver. Never point them at a production bot token.

## 1. Capture before forward and duplicate delivery

1. Start the gateway with the mock Bot API and plugin URLs.
2. POST a valid Telegram DM update to `/telegram/webhook` with the configured
   `X-Telegram-Bot-Api-Secret-Token`.
3. While the plugin receiver handles the request, query `telegram_updates`.
4. Verify the raw update and normalized message already exist before the plugin
   request completes.
5. POST the same `update_id` again.
6. Verify both webhook calls return 200, only one update and message row exist,
   and the plugin received one inbound request.

Pass: durable capture precedes forwarding and duplicate delivery is a no-op.

## 2. Edge and internal authentication

1. POST a webhook without the Telegram secret header and with a wrong secret.
2. Verify both return 401 and create no database rows.
3. POST `/send` without HMAC headers, with stale headers, and with a signature
   over different raw bytes.
4. Verify all three return 401 and make no Bot API request.
5. Repeat `/send` with a valid signature over the exact body bytes.

Pass: only authenticated exact-byte requests reach storage or Telegram.

## 3. Native outbound methods

1. Call the signed `/send`, `/send-media`, `/react`, and `/typing` endpoints.
2. Verify the mock Bot API receives, respectively, `sendMessage`, the correct
   native media method, `setMessageReaction`, and `sendChatAction`.
3. Exercise photo, animation, video, voice, audio, document, and sticker media.
4. Verify Telegram success payloads are returned without invented delivery IDs.

Pass: each gateway endpoint maps to the documented Bot API method and fields.

## 4. Operations endpoints

1. Call `/health` with the database and mock Bot API available.
2. Verify it reports database, bot identity, webhook, forwarding, and activity
   state without exposing any secret.
3. Call `/stats` and `/admin/webhook/setup` without and then with `x-admin-key`.
4. Verify setup calls `setWebhook` with the gateway webhook URL and configured
   secret token, then reports `getWebhookInfo`.

Pass: public health is safe and admin operations require the admin key.
