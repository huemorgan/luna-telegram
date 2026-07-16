# 002 — Telegram Multi-Account Gateway — Execution Report

**Branch:** `002-telegram-multi-account`
**Plan:** [`plans/002-telegram-multi-account/PLAN.md`](../../plans/002-telegram-multi-account/PLAN.md)
**Tests:** 58 unit/contract passed · 1/1 Postgres integration passed

---

## What was built

- AES-256-GCM credential encryption with strict 32-byte key parsing.
- Durable `telegram_accounts` registry keyed by Luna agent slug.
- Admin-key account create/list/get/patch/delete lifecycle API.
- BotFather token validation, duplicate-bot rejection, per-account webhook
  registration/verification, token+secret rotation, and non-destructive disable.
- Per-account Telegram edge auth, capture, forwarding URL/HMAC, outbound HMAC,
  and Bot API client selection.
- Explicit `x-tg-account` on gateway→plugin forwarding.
- Same-token shared-secret recovery for idempotent control-plane retries.
- Bot capability and normalized webhook metadata.
- Durable successful text/media delivery capture and native luna-service stats.
- Legacy `default` environment, webhook, and headerless outbound compatibility.
- Secret-free aggregate health/stats with `accounts[]`.
- Hosted Render/env configuration and gateway version 0.2.0.
- Synchronized vision, architecture, contract, and codemap docs.

## Contract / schema changes

- Telegram webhook: `/telegram/webhook/{account_id}`.
- Plugin outbound adds `x-tg-account`; signature bytes remain
  `timestamp + "." + rawBody`.
- Inbound envelope `account` is the resolved registry slug.
- Gateway and future plugin idempotency key is `(account, tg_update_id)`.
- `telegram_accounts` stores bot token, edge secret, and HMAC secret as separate
  AES-GCM ciphertext/IV/tag triples.
- Additive account capability columns preserve `getMe` group/privacy/inline
  state; `telegram_outbound` appends successful text/media deliveries.
- Existing update/message constraints migrate in place to account-scoped
  uniqueness and foreign keys. No table, column, or history row is deleted.

## Control-plane API

All routes require `x-admin-key`.

- `POST /accounts` body `{account_id, bot_token, inbound_url}` → 201 new or 200
  idempotent; response `{ok, account, shared_secret}` for create, rotation, or
  same-token recovery.
- `GET /accounts` → `{ok, accounts}`.
- `GET /accounts/{id}` → `{ok, account}`.
- `PATCH /accounts/{id}` body `{inbound_url? , bot_token?}` → `{ok, account,
  shared_secret?}`; only token creation/rotation/re-enable returns the secret.
- `DELETE /accounts/{id}` → `{ok, account}` after Telegram webhook deletion and
  local disable; capture and account rows remain.

Normal metadata never contains bot token, edge/HMAC secrets, ciphertext, IV, or
authentication tags.

## Monitoring output

`GET /stats` now returns `version: "0.2.0"`, `uptime_s`, `db`,
aggregate normalized `webhook`, `totals` (`accounts`, `active_chats`,
`messages_24h_in`, `messages_24h_out`, `forward_failures_24h`), `hourly`
`{hour,in,out}` buckets, and `accounts[]`. Each account includes `capabilities`,
normalized webhook fields plus raw `getWebhookInfo`, and
`messages_24h_in/out`. Existing flat counters remain for compatibility.

## Files

**New:** `gateway/src/accounts.js`, `gateway/src/crypto.js`,
`gateway/test/accounts.test.mjs`, plan/scenarios/report artifacts under
`002-telegram-multi-account`.

**Modified:** gateway config/bootstrap/app/database/normalization/Bot API,
package manifests, existing gateway tests, Render blueprint, and all relevant
vision docs.

## Test results

```text
cd gateway && npm ci && npm test
tests 59
pass 58
fail 0
skipped 1 (TEST_DATABASE_URL not set)
duration_ms 328.608834

TEST_DATABASE_URL=postgres://... node --test test/postgres.integration.test.mjs
tests 1
pass 1
fail 0
duration_ms 380.12075
```

`npm ci` audited 82 packages with 0 vulnerabilities. IDE diagnostics reported
no errors. Ruby YAML parsing confirmed the Render service/database blueprint.

A checked-in integration test, executed against disposable local Postgres 16,
verified:

1. fresh schema accepts the same update ID under two accounts and suppresses a
   duplicate within one account;
2. an actual v0.1 schema with retained update/message rows migrates to
   `PRIMARY KEY (account, update_id)`, preserves the old row, and accepts the
   same update ID under a second account;
3. additive capability columns, `telegram_outbound`, real in/out stats, hourly
   buckets, and per-account traffic metadata.

## Issues encountered & resolved

- Global update/message uniqueness could not support two Bot API update
  sequences. Constraints now migrate in place without dropping data.
- Hosted health previously depended on a legacy default bot. It now reports
  healthy when any registry account is enabled.
- Token validation distinguishes Telegram credential rejection (400) from
  Telegram/network unavailability (502).
- Raw Bot API network failures are sanitized before logging/responding so a URL
  containing the bot token cannot escape.
- Account provisioning verifies fresh `getWebhookInfo.url` before persisting an
  active route, so a missing/non-HTTPS public base or failed webhook cannot fake
  success.
- Idempotent POST originally withheld the existing shared secret, making a
  failed tenant-vault write unrecoverable. Admin auth plus successful validation
  of the same bot token now authorizes recovery; GET/list/stats remain redacted.
- Flat stats lacked real outbound data. Successful `/send` and `/send-media`
  deliveries now persist before response and feed the native luna-service
  totals/hourly/account shape.

## Concerns checklist

- ✓ Capture remains transactional and precedes forwarding.
- ✓ Credentials are authenticated ciphertext at rest.
- ✓ Account header binds HMAC verification and bot-token selection.
- ✓ Cross-account duplicate update IDs remain isolated.
- ✓ Normal account/stats responses are secret-free.
- ✓ Bot capabilities and webhook state are normalized for monitoring.
- ✓ Text/media outbound metrics come from durable delivery rows.
- ✓ Disconnect retains registry and captured history.
- ✓ Legacy fallback is `default` only and requires the complete env set.
- ✓ Official Bot API only; no userbot behavior.

## Version

Gateway `0.1.0` → `0.2.0`.

## Remaining / blocked

- No commit, push, deployment, live BotFather token, or production webhook was
  used.
- Companion implementations are complete locally: `plugin-telegram` v0.2.0
  binds `x-tg-account`, uses account-aware idempotency, and stores recovered
  credentials in the tenant vault; luna-service plan 045 forces
  `account_id == agent.slug` and consumes the normalized stats contract.
- The remaining API scenarios require deployment, a disposable BotFather bot,
  and a real hosted Luna.
