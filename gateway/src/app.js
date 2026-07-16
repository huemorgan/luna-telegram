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

function adminAuth(config) {
  return (req, res, next) => {
    if (!timingSafeTextEqual(req.get('x-admin-key'), config.adminKey)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    return next();
  };
}

function webhookAuth(config) {
  return (req, res, next) => {
    if (!timingSafeTextEqual(
      req.get('x-telegram-bot-api-secret-token'),
      config.webhookSecret,
    )) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    return next();
  };
}

function signedAuth(config) {
  return (req, res, next) => {
    const valid = verify(
      config.sharedSecret,
      req.rawBody ?? Buffer.alloc(0),
      req.get('x-tg-timestamp'),
      req.get('x-tg-signature'),
    );
    if (!valid) return res.status(401).json({ ok: false, error: 'invalid_signature' });
    return next();
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

export function buildHealth({ db, state, pendingForwards = 0 }) {
  const webhook = state?.webhook_info ?? null;
  const bot = state?.bot_id ? {
    id: state.bot_id,
    username: state.bot_username,
    name: state.bot_name,
  } : null;
  return {
    status: db.ok ? (bot && webhook?.url ? 'ok' : 'degraded') : 'error',
    account: 'default',
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
  telegram,
  initialBot = null,
  forward = forwardInbound,
  logger = console,
}) {
  const app = express();
  const runtime = { bot: initialBot };
  const pendingForwards = new Set();
  app.locals.runtime = runtime;
  app.locals.pendingForwards = pendingForwards;
  app.set('trust proxy', true);

  app.use('/telegram/webhook', webhookAuth(config));
  app.use(express.json({
    limit: '2mb',
    verify(req, _res, buffer) {
      req.rawBody = Buffer.from(buffer);
    },
  }));

  app.get('/health', async (_req, res) => {
    let db;
    let state = null;
    try {
      const latency = await store.ping();
      state = await store.getState();
      db = { ok: true, latency_ms: latency };
    } catch (error) {
      db = { ok: false, error: error.message };
    }
    const payload = buildHealth({ db, state, pendingForwards: pendingForwards.size });
    return res.status(db.ok ? 200 : 503).json(payload);
  });

  app.get('/stats', adminAuth(config), async (_req, res, next) => {
    try {
      const [stats, state] = await Promise.all([store.getStats(), store.getState()]);
      return res.json({ ok: true, account: 'default', ...numericStats(stats), state });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/admin/webhook/setup', adminAuth(config), async (req, res, next) => {
    try {
      const base = req.body?.public_url
        || config.publicUrl
        || `${req.protocol}://${req.get('host')}`;
      const parsed = new URL(base);
      if (parsed.protocol !== 'https:') {
        return res.status(400).json({ ok: false, error: 'public_url must use https' });
      }
      const webhookUrl = new URL('/telegram/webhook', `${parsed.origin}/`).toString();
      await telegram.setWebhook({
        url: webhookUrl,
        secret_token: config.webhookSecret,
        allowed_updates: ['message', 'edited_message', 'message_reaction'],
        ...(req.body?.drop_pending_updates != null
          ? { drop_pending_updates: Boolean(req.body.drop_pending_updates) }
          : {}),
      });
      const info = await telegram.getWebhookInfo();
      await store.updateTelegramState(runtime.bot, info);
      return res.json({ ok: true, webhook: info });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/telegram/webhook', async (req, res, next) => {
    try {
      const update = req.body;
      if (!Number.isSafeInteger(update?.update_id)) {
        return res.status(400).json({ ok: false, error: 'integer update_id is required' });
      }
      const type = updateType(update);
      const envelope = normalizeUpdate(update, runtime.bot ?? {});
      const inserted = await store.captureUpdate(update, type, envelope);
      if (!inserted) return res.json({ ok: true, duplicate: true });

      if (envelope) {
        const task = Promise.resolve().then(async () => {
          let result;
          try {
            result = await forward(envelope, {
              url: config.lunaInboundUrl,
              secret: config.sharedSecret,
              attempts: config.forwardAttempts,
              timeoutMs: config.forwardTimeoutMs,
            });
          } catch (error) {
            result = { ok: false, attempts: 0, error: error.message || String(error) };
          }
          await store.markForwardResult(update.update_id, result);
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
  });

  const signed = signedAuth(config);
  const outbound = (builder, { messageAck = false } = {}) => async (req, res, next) => {
    try {
      const { method, payload } = builder(req.body);
      const result = await telegram.call(method, payload);
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
  app.post('/send', signed, outbound(textPayload, { messageAck: true }));
  app.post('/send-media', signed, outbound(mediaPayload, { messageAck: true }));
  app.post('/react', signed, outbound(reactionPayload));
  app.post('/typing', signed, outbound(typingPayload));

  app.use((error, _req, res, _next) => {
    if (error instanceof SyntaxError && error.status === 400) {
      return res.status(400).json({ ok: false, error: 'invalid_json' });
    }
    logger.error('[http]', error);
    return res.status(502).json({
      ok: false,
      error: error.message || 'upstream_error',
      ...(error.code ? { code: error.code } : {}),
    });
  });

  return app;
}
