# 002 — Telegram Multi-Account Gateway

**Produces version:** gateway 0.2.0

## Context

Gateway 0.1 owns one Bot API token and routes one `default` account from global
environment variables. Hosted luna-service needs one Telegram bot per Luna
agent, provisioned through the control plane without exposing gateway admin
credentials or retaining plaintext BotFather tokens outside the gateway.

The companion luna-service plan is
`../luna-service/plans/045-telegram-service-page/PLAN.md`. It fixes
`account_id == agent.slug`, expects account lifecycle APIs, and stores the
returned per-account HMAC secret in that Luna's vault.

## Decisions

1. `telegram_accounts` is the durable routing registry. Account IDs are
   lowercase agent slugs and every webhook, forward, outbound call, and metric
   resolves through that row.
2. Bot token, Telegram webhook secret, and gateway↔plugin shared secret use
   AES-256-GCM at rest with `TELEGRAM_TOKEN_ENCRYPTION_KEY`. Ciphertext, IV, and
   authentication tag are stored separately; plaintext is only held while
   validating or calling Telegram and is never logged or returned after connect.
3. Account creation requires configured HTTPS `PUBLIC_URL`; it never claims
   success without `setWebhook` and fresh `getWebhookInfo`.
4. Token creation/rotation rotates both per-account edge and HMAC secrets. An
   admin POST proving possession of the same valid bot token also recovers the
   existing `shared_secret`, so a failed tenant-vault write is retryable.
5. DELETE calls Telegram `deleteWebhook`, disables the registry row, and retains
   all account and message history.
6. Legacy global credentials may seed/serve account `default`. Legacy webhook
   `/telegram/webhook` and outbound requests without `x-tg-account` resolve only
   to `default`; hosted accounts always use explicit account IDs.
7. Existing captured rows are preserved while global update constraints migrate
   safely to `(account, update_id)`. No table, column, or history row is deleted.

## Architecture impact

- `CONFLICT (resolved by this plan)`: v0.1 single-account scope becomes hosted
  multi-account routing while retaining a safe `default` compatibility path →
  update `vision/vision.md` § Scope.
- `ADD`: encrypted account registry and per-account Bot API clients →
  update `vision/architecture.md` § Data model and sequences.
- `ADD`: account lifecycle admin API, account webhook path, and
  `x-tg-account` HMAC routing → update `vision/contract.md`.
- `ADD`: hosted Render encryption/public URL configuration →
  update `render.yaml` and `gateway/.env.example`.

## Both-ends checklist

This changes the gateway↔plugin boundary.

- Gateway: `gateway/src/app.js`, `accounts.js`, `crypto.js`, `db.js`,
  `config.js`, `index.js`, `normalize.js`, `inbound.js`, and tests.
- Plugin: later companion implementation must send `x-tg-account`, persist
  messages uniquely by `(account, tg_update_id)`, and store the account secret
  supplied by luna-service.
- Contract: `vision/contract.md`.
- The exact-byte HMAC algorithm and fixture remain unchanged; account routing is
  an additional signed-request header, not part of the signature bytes.

## Concerns review

- Capture first remains transactional and now keys every row by account.
- Each Telegram token still has exactly one configured webhook owner.
- Edge and internal secrets are per-account and encrypted at rest.
- The account slug is resolved before HMAC verification or Bot API selection.
- Plugin activation/context remains tenant-local and policy-owned.
- Bot tokens and secrets are absent from list/get/stats/log/error responses.
- Official Bot API only; no personal-account or MTProto automation.
- Disconnect disables routing but preserves all captured history.

## Goals

1. Provision, inspect, rotate, and disable Telegram accounts through an
   admin-key control-plane API.
2. Isolate webhook authentication, capture, forwarding, outbound signing, and
   Bot API calls by account.
3. Encrypt all account credentials at rest and never expose bot tokens after
   submission.
4. Make update idempotency account-scoped.
5. Expose per-account operational metrics for luna-service.
6. Preserve safe v0.1 `default` compatibility.

## Non-goals

- Tenant authentication inside this gateway; luna-service owns tenant auth and
  is the sole holder of `GATEWAY_ADMIN_KEY`.
- Browser UI or luna-service route implementation.
- Plugin database migration in this repository.
- Deleting retained messages, updates, chats, or disabled account rows.
- Sharing one bot token between multiple Luna agents.
- Deploying, committing, or publishing during this execution.

## Approach

### 1. Contract and scenarios

- Write this plan and `tests/002-telegram-multi-account/api-scenarios.md` before
  source edits.
- Specify exact admin payloads/responses, secret-return rules, header behavior,
  and compatibility routes.

### 2. Secrets and registry

- Add AES-256-GCM helpers with strict 32-byte key parsing.
- Add `telegram_accounts` with encrypted bot/webhook/HMAC credentials, routing,
  identity, webhook state, enabled/status/error/activity timestamps.
- Add safe metadata shaping that cannot include credential columns.
- Seed/update `default` from complete legacy env configuration on startup.

### 3. Account-scoped capture

- Preserve tables and rows while migrating update/message uniqueness and foreign
  keys from global `update_id` to `(account, update_id)`.
- Pass `account_id` into normalization, capture, state, forward result, and
  stats queries.

### 4. Admin control plane

- `POST /accounts` validates `getMe`, encrypts credentials, registers
  `<PUBLIC_URL>/telegram/webhook/{account_id}`, and returns metadata plus a new
  shared secret only when created/rotated.
- `GET /accounts`, `GET /accounts/{id}`, `PATCH /accounts/{id}`, and
  `DELETE /accounts/{id}` are admin-key protected and secret-free except the
  explicit one-time shared-secret result.
- Token rotation validates and registers before replacing active routing.
- Inbound URL-only PATCH preserves credentials and shared secret.

### 5. Runtime routing

- Account webhook path resolves an enabled account and verifies its decrypted
  Telegram webhook secret.
- Forwarding uses that row's inbound URL/shared secret and envelope account.
- Signed outbound routes resolve `x-tg-account`, verify with that account's
  secret, and call Telegram with that account's decrypted token.
- Missing `x-tg-account` may resolve only legacy/default.

### 6. Operations and packaging

- `/health` reports aggregate registry state without secrets.
- `/stats` adds the luna-service native monitoring shape while retaining flat
  compatibility fields.
- Successful `/send` and `/send-media` deliveries are durably appended to
  `telegram_outbound` before acknowledgment so outbound monitoring is real.
- Render and `.env.example` require encryption key and public HTTPS URL; global
  bot/route secrets become optional compatibility inputs.
- Bump gateway package version to 0.2.0 and synchronize all vision docs.

### 7. Verification and reports

- Add comprehensive Node tests for encryption, account validation, lifecycle,
  secret redaction, per-account HMAC, webhook isolation, duplicate update IDs
  across accounts, disabled routing, compatibility, stats, and safe migrations.
- Run clean `npm ci && npm test`, diagnostics, and write the execution report and
  summary.

## Data / API contract

### Admin account metadata

```json
{
  "account_id": "agent-slug",
  "enabled": true,
  "status": "active",
  "inbound_url": "https://agent.example/api/p/plugin-telegram/inbound",
  "bot_id": "123456789",
  "bot_username": "tenant_bot",
  "bot_name": "Tenant Luna",
  "webhook": {"url":"https://gateway/telegram/webhook/agent-slug","pending_update_count":0},
  "created_at": "2026-07-16T12:00:00.000Z",
  "updated_at": "2026-07-16T12:00:00.000Z",
  "last_update_at": null,
  "last_forward_at": null,
  "last_error": null
}
```

Create/rotation response adds `"shared_secret": "<plaintext>"`. Repeating POST
with the same valid bot token also returns the existing shared secret for
idempotent recovery; admin authentication plus live token validation is the
proof. List/get/stats and inbound-only PATCH responses never include bot token,
webhook secret, shared secret, ciphertext, IV, or authentication tag.

### Control-plane routes

- `POST /accounts`
  body `{account_id, bot_token, inbound_url}`.
- `GET /accounts`
- `GET /accounts/{account_id}`
- `PATCH /accounts/{account_id}`
  body `{inbound_url? , bot_token?}` with at least one field.
- `DELETE /accounts/{account_id}`

All require `x-admin-key`. Account IDs match
`^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$`.

### Data-plane routes

- Telegram: `POST /telegram/webhook/{account_id}` with that account's
  `X-Telegram-Bot-Api-Secret-Token`.
- Plugin outbound: existing `/send`, `/send-media`, `/react`, `/typing` plus
  `x-tg-account: <account_id>`. Exact JSON-body HMAC remains unchanged.
- Inbound envelope `account` is the resolved account ID.
- Uniqueness is `(account, tg_update_id)` across gateway and plugin stores.

## Risks

- **Key loss:** encrypted bot tokens become unrecoverable. Render secret backup
  and rotation need an explicit future re-encryption procedure.
- **Partial Telegram registration:** validate/getMe and setWebhook happen before
  making a new route active; failures return non-success and do not fake
  provisioning.
- **Concurrent account changes:** registry writes are transactional and account
  key conflicts are serialized by Postgres upsert/update behavior.
- **Cross-tenant signing:** explicit account headers bind verification to one
  row; a valid signature for another account never falls through.
- **Migration:** constraint changes preserve all existing rows and default
  account values; tests assert no destructive table/column/history operation.
- **Legacy ambiguity:** headerless outbound is accepted only for `default`, never
  scanned against multiple account secrets.

## Acceptance criteria

- [x] All account credentials are AES-256-GCM encrypted at rest.
- [x] Account API validates Telegram and requires configured HTTPS PUBLIC_URL.
- [x] Create/rotation and same-token recovery return the shared secret; all
      read-only metadata is secret-free.
- [x] Per-account webhooks authenticate, capture, and forward in isolation.
- [x] The same Telegram `update_id` is accepted once per account.
- [x] Outbound HMAC and Bot API clients resolve by `x-tg-account`.
- [x] DELETE disables routing/deletes Telegram webhook without deleting history.
- [x] Legacy `default` compatibility works only when fully configured.
- [x] `/stats` includes secret-free `accounts[]`.
- [x] Package and docs report 0.2.0 and the hosted contract.
- [x] Clean Node test suite and diagnostics pass.
- [x] Execution report and summary record evidence and remaining live checks.

## Verification

```bash
cd gateway
npm ci
npm test
```

Then, with disposable Postgres and mock Telegram/plugin endpoints, execute every
scenario under `tests/002-telegram-multi-account/`. Production webhook and
tenant UI verification remain for the luna-service companion phase.

## Plan amendments

Cross-repo release review added: explicit `x-tg-account` on gateway→plugin
forwarding; recoverable same-token POST; Bot API capability metadata; normalized
webhook metadata; durable outbound delivery capture; and the native luna-service
stats shape. These refine the hosted control/monitoring contract without
changing account isolation or encryption decisions.
