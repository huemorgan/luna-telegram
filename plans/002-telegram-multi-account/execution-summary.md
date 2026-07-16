# 002 — Telegram Multi-Account Gateway — Execution Summary

**Executed:** 2026-07-16 · **Outcome:** gateway shipped locally
**Deployed:** not deployed

## What was accomplished

Gateway 0.2.0 now supports one encrypted Telegram bot account per hosted Luna
agent slug. Account provisioning validates Telegram, registers a distinct HTTPS
webhook, returns the per-account HMAC secret once, and stores all three account
credentials with AES-256-GCM. Webhook capture, Luna forwarding, outbound HMAC,
Bot API selection, idempotency, health, and stats are account-scoped.
Release integration now also includes recoverable same-token shared-secret
provisioning, bot privacy/group capability metadata, explicit account headers
on inbound forwarding, durable outbound delivery rows, and the native
luna-service monitoring shape.

The v0.1 `default` path remains available only when the complete legacy env set
is present. Existing captured rows migrate safely from global `update_id`
constraints to `(account, update_id)` without deleting history.

All 58 unit/contract tests and the checked-in fresh/legacy Postgres 16
integration test pass.

## What we discovered along the way

The multi-account idempotency requirement needs a real constraint migration, not
just an additional index: the v0.1 primary key and message foreign key enforced
global update IDs. The implemented migration drops only those constraints,
rebuilds account-scoped constraints, and preserves every row.

Hosted health cannot use the old default bot identity as its readiness signal.
It now derives healthy account availability from the encrypted registry while
still exposing default compatibility state when present.

Provisioning is only truthful after both `setWebhook` and a matching
`getWebhookInfo.url`; merely validating the token is insufficient.

## Things to consider in the future

- Add an explicit encryption-key rotation/re-encryption operation before the
  first production key change.
- Add durable replay for captured rows that miss forwarding during the
  acknowledged crash window.
- The account-aware plugin migration and luna-service plan 045 control-plane/UI
  work are implemented locally and need to be deployed together with this
  gateway.
- Exercise two real BotFather bots through Render and two hosted Luna agents,
  including cross-tenant negative tests and disconnect/reconnect.
