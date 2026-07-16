# 001 — Telegram Gateway — Execution Report

**Branch:** `001-telegram-gateway`
**Plan:** [`plans/001-telegram-gateway/PLAN.md`](../../plans/001-telegram-gateway/PLAN.md)
**Tests:** 44/44 Node tests passed

---

## What was built

- Node 20 ESM/Express/pg single-account gateway using raw `fetch` for the
  Telegram Bot API.
- Telegram-secret authenticated webhook with transactional raw/normalized
  capture before asynchronous signed forwarding.
- Normalization for DMs, groups, addressing flags, edits, media, contacts,
  locations, service messages, and reactions.
- Exact-byte `x-tg-timestamp`/`x-tg-signature` HMAC in both directions.
- Signed text, native media, reaction, and chat-action endpoints.
- Public health, admin stats, and admin webhook setup.
- Postgres schema, Docker packaging, environment template, and Oregon Render
  blueprint.
- Vision, architecture, wire-contract, and codemap documentation.

## Contract / schema changes

The new contract is documented in `vision/contract.md`. The gateway uses
`account: "default"`, plugin idempotency on `tg_update_id`, exact-byte HMAC, and
native Bot API payloads. The database adds `telegram_updates`,
`telegram_messages`, `telegram_chats`, and singleton `telegram_state`.

## Files

**New:** all files under `gateway/`, `vision/`, and
`tests/001-telegram-gateway/`, plus root `render.yaml`.

**Existing:** `plans/001-telegram-gateway/PLAN.md` was followed without source
scope amendments.

**Integration revision:** `gateway/src/normalize.js`, `gateway/src/app.js`,
`gateway/src/telegram.js`, their normalization/contract/route tests,
`vision/contract.md`, this report, and the plan execution summary.

## Test results

```text
cd gateway && npm test
tests 44
pass 44
fail 0
duration_ms 366.963042
```

Coverage includes normalization, webhook/admin/HMAC authentication,
capture-before-forward ordering, duplicate suppression, transaction query
ordering, native outbound payloads, Bot API errors, bounded forwarding, and the
cross-language HMAC fixture. Integration regression cases cover typed inbound
media, channel/other sender-null envelopes, canonical outbound request fields,
and top-level send acknowledgements.

Clean `npm ci` reported 0 vulnerabilities. IDE diagnostics reported no errors
in gateway source or tests.

## Issues encountered & resolved

- Corrected two fixture timestamp expectations to their actual UTC values.
- Reaction updates do not include the target message author. The contract now
  leaves `is_reply_to_me` false and requires the plugin to resolve the target
  from `chat_id` + `tg_msg_id`.
- Unexpected forwarding exceptions are converted to persisted forwarding
  failures rather than becoming unhandled background rejections.
- Plugin integration review exposed missing media discriminators and send
  acknowledgements. Every inbound media object is now explicitly typed;
  `/send` and `/send-media` return top-level `tg_msg_id`; non-canonical request
  field aliases are rejected and covered by route tests.

## Concerns checklist

- ✓ Every authenticated update commits before forwarding.
- ✓ `update_id` is unique and duplicate delivery does not forward twice.
- ✓ Telegram edge and internal hops use separate authentication.
- ✓ Raw updates survive unsupported event types.
- ✓ Activation annotations are computed, while policy remains plugin-owned.
- ✓ Official Bot API only; no userbot behavior.
- ✓ Single-account v0.1 is explicit in code, blueprint, and docs.

## Version

New gateway version: `0.1.0`.

## Remaining / blocked

- No GitHub repository, commit, push, Render deployment, webhook registration,
  real bot round-trip, or live plugin test was performed, per the instruction
  not to commit, push, or deploy.
- The separate `plugin-telegram` implementation and Python fixture test are not
  part of this gateway repository. Its required assumptions are documented in
  `vision/contract.md`.
- Postgres behavior is tested at the store/query-contract level; a live
  disposable-Postgres integration remains part of deployment verification.
