# Codemap

## Repository

- `render.yaml` — Oregon Render web service and Postgres blueprint.
- `plans/001-telegram-gateway/PLAN.md` — delivery plan and acceptance criteria.
- `plans/002-telegram-multi-account/PLAN.md` — encrypted hosted account
  provisioning and routing.
- `tests/001-telegram-gateway/api-scenarios.md` — manual integration scenarios.
- `tests/002-telegram-multi-account/api-scenarios.md` — tenant isolation,
  lifecycle, rotation, and fleet-operation scenarios.
- `vision/vision.md` — product and platform boundaries.
- `vision/architecture.md` — topology, sequences, persistence, and failures.
- `vision/contract.md` — exact gateway↔plugin wire contract.

## Gateway runtime

- `gateway/src/index.js` — bootstrap schema, read bot/webhook identity, start and
  stop HTTP server.
- `gateway/src/accounts.js` — account ID validation, safe metadata, encrypted
  credential lifecycle, webhook provisioning, rotation, and disable.
- `gateway/src/crypto.js` — AES-256-GCM key parsing/encrypt/decrypt helpers.
- `gateway/src/config.js` — required and optional environment parsing.
- `gateway/src/app.js` — Express routes, edge/admin/HMAC authentication, health,
  stats, webhook capture ordering, and outbound dispatch.
- `gateway/src/telegram.js` — raw-fetch Bot API client and native outbound
  payload builders.
- `gateway/src/normalize.js` — Telegram update classification and normalized
  message/edit/media/reaction envelopes.
- `gateway/src/db.js` — Postgres schema and durable store.
- `gateway/src/inbound.js` — exact-byte signed forwarding with bounded retries.
- `gateway/src/hmac.js` — shared HMAC signing and verification.

## Packaging and configuration

- `gateway/package.json` / `package-lock.json` — Node 20 ESM package and pinned
  Express/pg dependency graph.
- `gateway/Dockerfile` — production Node 20 image.
- `gateway/.env.example` — complete local configuration template.
- `gateway/.gitignore` / `.dockerignore` — local secret/build exclusions.

## Tests

- `gateway/test/normalize.test.mjs` — DM, group addressing, edits, all inbound
  media classes, contacts, location, service events, reactions, unknown updates.
- `gateway/test/contract.test.mjs` — HMAC fixture/exact bytes, outbound Bot API
  payloads, raw client behavior, signed forwarding/retry.
- `gateway/test/app.test.mjs` — edge/admin/HMAC auth, capture-before-forward,
  idempotency, operations endpoints, and outbound route mapping.
- `gateway/test/db.test.mjs` — schema guarantees and transaction ordering.
- `gateway/test/accounts.test.mjs` — encryption, provisioning, idempotency,
  redaction, rotation, duplicate-bot rejection, and disconnect.
- `gateway/test/postgres.integration.test.mjs` — optional
  `TEST_DATABASE_URL` fresh schema, outbound stats, and retained-history
  migration coverage.

## Separate plugin repository

`plugin-telegram` is intentionally not copied into this repository. Its inbound
route, client, HMAC implementation, idempotency, activation policy, context
store, and `luna_sdk` integration must implement `vision/contract.md`.
