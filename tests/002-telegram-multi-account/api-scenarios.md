# Telegram multi-account browser/API scenarios

Use a disposable Postgres database, mock Telegram Bot API, and two mock Luna
plugin receivers. Never use production bot tokens.

## 1. Provision two isolated accounts

1. Start the gateway with `PUBLIC_URL=https://gateway.example`, an encryption
   key, and no global bot token.
2. POST `/accounts` twice with admin auth for `agent-a` and `agent-b`, distinct
   mock bot tokens, and distinct inbound URLs.
3. Verify each token is checked with `getMe` and each bot receives
   `setWebhook` for `/telegram/webhook/<account_id>` with a distinct secret.
4. Verify each create response contains metadata and one `shared_secret`, but no
   bot token, webhook secret, ciphertext, IV, or authentication tag.
5. Query Postgres and verify credential columns are ciphertext, not submitted
   plaintext.
6. GET list and each account; verify no response contains any secret.
7. Simulate a failed tenant-vault write and repeat POST with the same valid bot
   token; verify the existing `shared_secret` is recovered and unchanged.
8. Verify GET/list/stats still never expose that secret.

Pass: both accounts are active, isolated, encrypted, and safely observable.

## 2. Reject fake or partial provisioning

1. Start without `PUBLIC_URL`; POST a valid account.
2. Verify the request fails before reporting success and no active route exists.
3. Configure a non-HTTPS public URL and repeat; verify failure.
4. Configure HTTPS but make `getMe` reject the token; verify no account,
   webhook, or shared secret is persisted/returned.
5. Make `setWebhook` fail; verify the account is not reported active.

Pass: provisioning succeeds only after token validation and webhook
registration.

## 3. Account-scoped webhook capture

1. Deliver update ID `100` to both account webhook paths with each account's
   correct Telegram secret.
2. Verify two `telegram_updates` and two normalized message rows exist, keyed by
   `(account, update_id)`.
3. Verify each Luna receiver gets one envelope with its own `account`.
4. Verify each forward sends `x-tg-account` exactly equal to envelope `account`.
5. Redeliver update ID `100` to each account; verify no second forward.
6. Cross-send each account's edge secret to the other path; verify 401 and no
   rows.

Pass: identical Telegram update IDs and credentials cannot collide across
accounts.

## 4. Account-scoped outbound HMAC

1. Sign `/send` using `agent-a` shared secret and send `x-tg-account: agent-a`.
2. Verify only agent A's bot token is used.
3. Replay the same body/signature while claiming `agent-b`.
4. Verify 401 and no Bot API call.
5. Omit `x-tg-account` in hosted mode; verify no account scan/fallback occurs.
6. Seed a legacy `default` account and verify a headerless signed request still
   resolves only to `default`.

Pass: the account header binds signature verification and token selection.

## 5. Rotate and disconnect safely

1. PATCH only `inbound_url`; verify the account remains active, the webhook is
   unchanged, and no `shared_secret` is returned.
2. PATCH `bot_token`; verify `getMe`, new webhook registration, rotated edge/HMAC
   secrets, and one newly returned `shared_secret`.
3. Verify the old edge and HMAC secrets no longer authenticate.
4. DELETE the account; verify Telegram `deleteWebhook` is called and account
   metadata reports disabled.
5. Verify old webhook/outbound requests are rejected.
6. Query update/message history and verify every prior row remains.

Pass: rotation changes credentials safely and disconnect never destroys
capture.

## 6. Fleet operations

1. Call `/health` and admin `/stats`.
2. Verify health reports aggregate account counts and no secrets.
3. Verify stats contains `accounts[]` with each slug, bot identity, status,
   capabilities, normalized+raw webhook metadata, activity/errors, and
   account-scoped inbound/outbound counts.
4. Search serialized responses for submitted tokens, shared secrets, webhook
   secrets, and encrypted credential fields.
5. Send one text, one media message, one reaction, and one typing action.
6. Verify only text/media append `telegram_outbound`, before their HTTP
   responses, and `/stats` reports version, uptime, DB, aggregate webhook,
   totals, hourly in/out, and compatibility flat fields.

Pass: luna-service receives complete secret-free monitoring data.
