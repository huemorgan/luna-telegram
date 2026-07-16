# luna-telegram — Vision

## One sentence

Put a Luna agent behind an official Telegram bot, with every delivered update
captured durably before Luna is asked to act.

## Platform model

Telegram is not WhatsApp Web. The identity is a bot created with BotFather, not
the owner's personal account. It receives DMs sent to the bot and only the group
traffic Telegram permits for that bot. Privacy mode, bot membership, admin
rights, and Telegram's update rules determine what can be observed. This project
does not use MTProto, automate a personal account, or claim access to unrelated
owner chats.

Production delivery uses one HTTPS webhook per bot token. The gateway owns that
webhook, the token, durable capture, and outbound Bot API calls. Luna remains
restartable and receives normalized events over a signed HTTP boundary.

## Product principles

1. **Capture before action.** A valid Telegram update is committed to Postgres
   before forwarding. `(account, update_id)` is the idempotency key.
2. **Use the official API.** Native Bot API messages, media, reactions, and chat
   actions are preferred over invented abstractions.
3. **Authenticate every boundary.** Telegram's webhook secret protects the
   public edge; exact-byte timestamped HMAC protects gateway↔plugin traffic.
4. **Preserve raw updates.** Unknown update types remain durable so support can
   be added without losing history.
5. **Answer with judgment.** The plugin, not the gateway, decides whether to
   answer. Current policy: DMs activate; groups activate on a mention,
   command, or reply to the bot.
6. **Stay honest about reliability.** v0.2 performs bounded forwarding attempts
   after capture and exposes failures. It does not yet run a durable replay
   worker.

## Scope

Version 0.2 is a multi-account transport for hosted luna-service: one BotFather
bot and one encrypted gateway registry row per Luna agent slug. luna-service
owns tenant authentication and calls the gateway's admin-key account API; the
gateway owns bot-token validation, per-account webhook registration, encrypted
credentials, capture, routing, and native Bot API calls. A legacy `default`
account can still be seeded from the complete v0.1 environment set.

Bot tokens, Telegram webhook secrets, and gateway↔plugin HMAC secrets are
AES-256-GCM encrypted at rest. Normal monitoring and account responses never
contain credentials. The per-account HMAC secret is returned on creation,
rotation, or an admin-authenticated same-token recovery so luna-service can
reliably put it in that Luna's vault.

Supported inbound normalization covers messages, edits, service messages,
media metadata, and message reactions. Supported outbound methods cover text,
photos, animations/GIFs, video, voice, audio, documents, stickers, replies,
reactions, and typing/upload actions.

## Non-goals

- Personal-account automation or arbitrary Telegram history access.
- Tenant authentication, billing, or browser provisioning UI; those remain in
  luna-service.
- Payments, inline mode, moderation, channels as a product surface, or forum
  administration in v0.2.
- Downloading or proxying Telegram files; normalized media preserves `file_id`
  and metadata for the plugin to resolve when needed.
- Exactly-once forwarding across a crash after webhook acknowledgement. Storage
  is exactly-once by `(account, update_id)`; forwarding is bounded and the
  plugin must use the same account-aware idempotency key.
