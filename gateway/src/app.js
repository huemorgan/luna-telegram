import express from 'express';
import { timingSafeTextEqual, verify } from './hmac.js';
import { forwardInbound } from './inbound.js';
import { normalizeUpdate, updateType } from './normalize.js';
import {
  mediaPayload,
  reactionPayload,
  textPayload,
  typingPayload,
} from './telegram.js';

export const GATEWAY_VERSION = '0.2.0';

function adminAuth(config) {
  return (req, res, next) => {
    if (!timingSafeTextEqual(req.get('x-admin-key'), config.adminKey)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    return next();
  };
}

function signedAuth(accountManager) {
  return async (req, res, next) => {
    try {
      const accountId = req.get('x-tg-account') || 'default';
      const runtime = await accountManager.getRuntime(accountId);
      const valid = verify(
        runtime.sharedSecret,
        req.rawBody ?? Buffer.alloc(0),
        req.get('x-tg-timestamp'),
        req.get('x-tg-signature'),
      );
      if (!valid) return res.status(401).json({ ok: false, error: 'invalid_signature' });
      req.telegramAccount = runtime;
      return next();
    } catch {
      return res.status(401).json({ ok: false, error: 'invalid_signature' });
    }
  };
}

function numericStats(stats) {
  return Object.fromEntries(Object.entries(stats).map(([key, value]) => {
    if (key === 'kinds_24h') {
      return [key, value.map((row) => ({ kind: row.kind, count: Number(row.count) }))];
    }
    if (value != null && /^-?\d+$/.test(String(value))) return [key, Number(value)];
    return [key, value instanceof Date ? value.toISOString() : value];
  }));
}

function aggregateWebhook(accounts) {
  const enabled = accounts.filter((account) => account.enabled);
  const errors = enabled
    .filter((account) => account.webhook?.last_error_at)
    .sort((a, b) => b.webhook.last_error_at.localeCompare(a.webhook.last_error_at));
  return {
    configured: enabled.length > 0
      && enabled.every((account) => account.webhook?.configured),
    pending_update_count: enabled.reduce(
      (sum, account) => sum + Number(account.webhook?.pending_update_count ?? 0),
      0,
    ),
    last_error_at: errors[0]?.webhook.last_error_at ?? null,
    last_error_message: errors[0]?.webhook.last_error_message ?? null,
  };
}

export function buildStatsPayload({
  stats,
  accounts,
  state,
  dbLatencyMs,
  uptimeSeconds = process.uptime(),
}) {
  const flat = numericStats({ ...stats, accounts });
  return {
    ok: true,
    version: GATEWAY_VERSION,
    uptime_s: Math.floor(uptimeSeconds),
    db: { ok: true, latency_ms: dbLatencyMs },
    webhook: aggregateWebhook(accounts),
    totals: {
      accounts: accounts.length,
      active_chats: Number(stats.active_chats ?? 0),
      messages_24h_in: Number(stats.messages_24h_in ?? 0),
      messages_24h_out: Number(stats.messages_24h_out ?? 0),
      forward_failures_24h: Number(stats.forward_failures_24h ?? 0),
    },
    ...flat,
    hourly: (stats.hourly ?? []).map((row) => ({
      hour: row.hour instanceof Date ? row.hour.toISOString() : row.hour,
      in: Number(row.in),
      out: Number(row.out),
    })),
    state,
    account: 'default',
  };
}

export function buildHealth({ db, state, accounts = { total: 0, enabled: 0 }, pendingForwards = 0 }) {
  const webhook = state?.webhook_info ?? null;
  const bot = state?.bot_id ? {
    id: state.bot_id,
    username: state.bot_username,
    name: state.bot_name,
  } : null;
  return {
    status: db.ok
      ? (accounts.enabled > 0 || (bot && webhook?.url) ? 'ok' : 'degraded')
      : 'error',
    account: 'default',
    accounts,
    db,
    bot,
    webhook: webhook ? {
      url: webhook.url ?? '',
      pending_update_count: webhook.pending_update_count ?? 0,
      last_error_date: webhook.last_error_date ?? null,
      last_error_message: webhook.last_error_message ?? null,
    } : null,
    forwarding: {
      pending: pendingForwards,
      last_forward_at: state?.last_forward_at ?? null,
      last_error: state?.last_forward_error ?? null,
    },
    activity: {
      last_update_at: state?.last_update_at ?? null,
    },
  };
}

export function createApp({
  config,
  store,
  accountManager,
  forward = forwardInbound,
  logger = console,
}) {
  const app = express();
  const pendingForwards = new Set();
  app.locals.pendingForwards = pendingForwards;
  app.set('trust proxy', true);

  app.use(express.json({
    limit: '2mb',
    verify(req, _res, buffer) {
      req.rawBody = Buffer.from(buffer);
    },
  }));

  app.get('/health', async (_req, res) => {
    let db;
    let state = null;
    let accounts = { total: 0, enabled: 0 };
    try {
      const latency = await store.ping();
      [state, accounts] = await Promise.all([
        store.getState(),
        store.getAccountCounts(),
      ]);
      db = { ok: true, latency_ms: latency };
    } catch (error) {
      db = { ok: false, error: error.message };
    }
    const payload = buildHealth({
      db,
      state,
      accounts,
      pendingForwards: pendingForwards.size,
    });
    return res.status(db.ok ? 200 : 503).json(payload);
  });

  app.get('/stats', adminAuth(config), async (_req, res, next) => {
    try {
      const [dbLatencyMs, stats, state, accounts] = await Promise.all([
        store.ping(),
        store.getStats(),
        store.getState(),
        accountManager.listMetadata(),
      ]);
      return res.json(buildStatsPayload({
        stats,
        accounts,
        state,
        dbLatencyMs,
      }));
    } catch (error) {
      return next(error);
    }
  });

  app.post('/accounts', adminAuth(config), async (req, res, next) => {
    try {
      const provisioned = await accountManager.provision(req.body ?? {});
      return res.status(provisioned.created ? 201 : 200).json({
        ok: true,
        account: provisioned.account,
        ...(provisioned.shared_secret
          ? { shared_secret: provisioned.shared_secret }
          : {}),
      });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/accounts', adminAuth(config), async (_req, res, next) => {
    try {
      return res.json({ ok: true, accounts: await accountManager.listMetadata() });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/accounts/:accountId', adminAuth(config), async (req, res, next) => {
    try {
      return res.json({
        ok: true,
        account: await accountManager.getMetadata(req.params.accountId),
      });
    } catch (error) {
      return next(error);
    }
  });

  app.patch('/accounts/:accountId', adminAuth(config), async (req, res, next) => {
    try {
      const patched = await accountManager.patch(req.params.accountId, req.body ?? {});
      return res.json({
        ok: true,
        account: patched.account,
        ...(patched.shared_secret ? { shared_secret: patched.shared_secret } : {}),
      });
    } catch (error) {
      return next(error);
    }
  });

  app.delete('/accounts/:accountId', adminAuth(config), async (req, res, next) => {
    try {
      return res.json({
        ok: true,
        account: await accountManager.disable(req.params.accountId),
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/admin/webhook/setup', adminAuth(config), async (req, res, next) => {
    try {
      const runtime = await accountManager.getRuntime('default');
      const base = req.body?.public_url
        || config.publicUrl
        || `${req.protocol}://${req.get('host')}`;
      const parsed = new URL(base);
      if (parsed.protocol !== 'https:') {
        return res.status(400).json({ ok: false, error: 'public_url must use https' });
      }
      const webhookUrl = new URL('/telegram/webhook', `${parsed.origin}/`).toString();
      await runtime.client.setWebhook({
        url: webhookUrl,
        secret_token: runtime.webhookSecret,
        allowed_updates: ['message', 'edited_message', 'message_reaction'],
        ...(req.body?.drop_pending_updates != null
          ? { drop_pending_updates: Boolean(req.body.drop_pending_updates) }
          : {}),
      });
      const info = await runtime.client.getWebhookInfo();
      await store.updateTelegramState('default', runtime.bot, info);
      return res.json({ ok: true, webhook: info });
    } catch (error) {
      return next(error);
    }
  });

  const webhook = async (req, res, next) => {
    try {
      const accountId = req.params.accountId || 'default';
      const runtime = await accountManager.getRuntime(accountId);
      if (!timingSafeTextEqual(
        req.get('x-telegram-bot-api-secret-token'),
        runtime.webhookSecret,
      )) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
      }
      const update = req.body;
      if (!Number.isSafeInteger(update?.update_id)) {
        return res.status(400).json({ ok: false, error: 'integer update_id is required' });
      }
      const type = updateType(update);
      const envelope = normalizeUpdate(update, runtime.bot, accountId);
      const inserted = await store.captureUpdate(accountId, update, type, envelope);
      if (!inserted) return res.json({ ok: true, duplicate: true });

      if (envelope) {
        const task = Promise.resolve().then(async () => {
          let result;
          try {
            result = await forward(envelope, {
              url: runtime.account.inbound_url,
              secret: runtime.sharedSecret,
              attempts: config.forwardAttempts,
              timeoutMs: config.forwardTimeoutMs,
            });
          } catch (error) {
            result = { ok: false, attempts: 0, error: error.message || String(error) };
          }
          await store.markForwardResult(accountId, update.update_id, result);
          if (!result.ok) logger.error('[inbound] forward failed:', result.error);
        }).catch((error) => {
          logger.error('[inbound] forward bookkeeping failed:', error.message);
        }).finally(() => {
          pendingForwards.delete(task);
        });
        pendingForwards.add(task);
      }
      return res.json({ ok: true, captured: true, normalized: Boolean(envelope) });
    } catch (error) {
      return next(error);
    }
  };
  app.post('/telegram/webhook/:accountId', webhook);
  app.post('/telegram/webhook', webhook);

  const signed = signedAuth(accountManager);
  const outbound = (
    builder,
    { messageAck = false, recordKind = null } = {},
  ) => async (req, res, next) => {
    try {
      const { method, payload } = builder(req.body);
      const result = await req.telegramAccount.client.call(method, payload);
      if (recordKind && Number.isSafeInteger(result?.message_id)) {
        await store.recordOutbound({
          accountId: req.telegramAccount.account.account_id,
          chatId: payload.chat_id,
          tgMsgId: result.message_id,
          kind: typeof recordKind === 'function' ? recordKind(req) : recordKind,
          method,
          response: result,
        });
      }
      return res.json({
        ok: true,
        method,
        result,
        ...(messageAck && Number.isSafeInteger(result?.message_id)
          ? { tg_msg_id: result.message_id }
          : {}),
      });
    } catch (error) {
      if (error instanceof TypeError) {
        return res.status(400).json({ ok: false, error: error.message });
      }
      return next(error);
    }
  };
  app.post('/send', signed, outbound(textPayload, {
    messageAck: true,
    recordKind: 'text',
  }));
  app.post('/send-media', signed, outbound(mediaPayload, {
    messageAck: true,
    recordKind: (req) => req.body.kind,
  }));
  app.post('/react', signed, outbound(reactionPayload));
  app.post('/typing', signed, outbound(typingPayload));

  app.use((error, _req, res, _next) => {
    if (error instanceof SyntaxError && error.status === 400) {
      return res.status(400).json({ ok: false, error: 'invalid_json' });
    }
    const status = Number.isInteger(error.status) ? error.status : 502;
    if (status >= 500) logger.error('[http]', error);
    return res.status(status).json({
      ok: false,
      error: error.message || 'upstream_error',
      ...(error.code ? { code: error.code } : {}),
    });
  });

  return app;
}
