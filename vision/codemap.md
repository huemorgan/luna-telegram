# Codemap

## Repository

- `render.yaml` — Oregon Render web service and Postgres blueprint.
- `plans/001-telegram-gateway/PLAN.md` — delivery plan and acceptance criteria.
- `tests/001-telegram-gateway/api-scenarios.md` — manual integration scenarios.
- `vision/vision.md` — product and platform boundaries.
- `vision/architecture.md` — topology, sequences, persistence, and failures.
- `vision/contract.md` — exact gateway↔plugin wire contract.

## Gateway runtime

- `gateway/src/index.js` — bootstrap schema, read bot/webhook identity, start and
  stop HTTP server.
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

## Separate plugin repository

`plugin-telegram` is intentionally not copied into this repository. Its inbound
route, client, HMAC implementation, idempotency, activation policy, context
store, and `luna_sdk` integration must implement `vision/contract.md`.
