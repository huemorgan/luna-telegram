import {
  decryptSecret,
  encryptSecret,
  generateSecret,
  parseEncryptionKey,
} from './crypto.js';

const ACCOUNT_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const ALLOWED_UPDATES = ['message', 'edited_message', 'message_reaction'];

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function validAccountId(value) {
  return typeof value === 'string' && ACCOUNT_ID.test(value);
}

function encryptedFromRow(row, name) {
  return {
    ciphertext: row[`${name}_ciphertext`],
    iv: row[`${name}_iv`],
    tag: row[`${name}_tag`],
  };
}

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function telegramTime(value) {
  return Number.isFinite(Number(value))
    ? new Date(Number(value) * 1000).toISOString()
    : null;
}

export function normalizeWebhook(raw) {
  if (!raw) {
    return {
      configured: false,
      url: '',
      pending_update_count: 0,
      last_error_at: null,
      last_error_message: null,
      raw: null,
    };
  }
  return {
    configured: Boolean(raw.url),
    url: raw.url ?? '',
    pending_update_count: Number(raw.pending_update_count ?? 0),
    last_error_at: telegramTime(raw.last_error_date),
    last_error_message: raw.last_error_message ?? null,
    raw,
  };
}

export function accountMetadata(row) {
  return {
    account_id: row.account_id,
    enabled: Boolean(row.enabled),
    status: row.status,
    inbound_url: row.inbound_url,
    bot_id: row.bot_id,
    bot_username: row.bot_username ?? null,
    bot_name: row.bot_name ?? null,
    capabilities: {
      can_join_groups: row.can_join_groups ?? null,
      can_read_all_group_messages: row.can_read_all_group_messages ?? null,
      supports_inline_queries: row.supports_inline_queries ?? null,
    },
    webhook: normalizeWebhook(row.webhook_info),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    disabled_at: iso(row.disabled_at),
    last_update_at: iso(row.last_update_at),
    last_forward_at: iso(row.last_forward_at),
    last_error: row.last_error ?? null,
    ...(row.messages_24h_in != null
      ? {
        messages_24h: Number(row.messages_24h_in),
        messages_24h_in: Number(row.messages_24h_in),
      }
      : {}),
    ...(row.messages_24h_out != null
      ? { messages_24h_out: Number(row.messages_24h_out) }
      : {}),
    ...(row.chats_24h != null ? { chats_24h: Number(row.chats_24h) } : {}),
    ...(row.forward_failures != null
      ? { forward_failures: Number(row.forward_failures) }
      : {}),
  };
}

function validateInboundUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    return url.toString();
  } catch {
    throw new HttpError(400, 'inbound_url must be an absolute HTTP(S) URL', 'invalid_inbound_url');
  }
}

export class AccountManager {
  constructor({ store, encryptionKey, publicUrl, telegramFactory }) {
    this.store = store;
    this.key = Buffer.isBuffer(encryptionKey)
      ? encryptionKey
      : parseEncryptionKey(encryptionKey);
    this.publicUrl = publicUrl?.replace(/\/+$/, '') || '';
    this.telegramFactory = telegramFactory;
  }

  webhookUrl(accountId) {
    let url;
    try {
      url = new URL(this.publicUrl);
    } catch {
      throw new HttpError(503, 'PUBLIC_URL is required for account provisioning', 'public_url_required');
    }
    if (url.protocol !== 'https:') {
      throw new HttpError(503, 'PUBLIC_URL must use HTTPS', 'public_url_https_required');
    }
    return new URL(`/telegram/webhook/${accountId}`, `${url.origin}/`).toString();
  }

  assertAccountId(accountId) {
    if (!validAccountId(accountId)) {
      throw new HttpError(400, 'invalid account_id', 'invalid_account_id');
    }
  }

  decryptRow(row) {
    return {
      account: row,
      botToken: decryptSecret(this.key, encryptedFromRow(row, 'bot_token')),
      webhookSecret: decryptSecret(this.key, encryptedFromRow(row, 'webhook_secret')),
      sharedSecret: decryptSecret(this.key, encryptedFromRow(row, 'shared_secret')),
    };
  }

  async getRuntime(accountId, { enabledOnly = true } = {}) {
    this.assertAccountId(accountId);
    const row = await this.store.getAccount(accountId);
    if (!row || (enabledOnly && !row.enabled)) {
      throw new HttpError(404, 'account not found', 'account_not_found');
    }
    const secrets = this.decryptRow(row);
    return {
      ...secrets,
      client: this.telegramFactory(secrets.botToken),
      bot: {
        id: row.bot_id,
        username: row.bot_username,
        first_name: row.bot_name,
      },
    };
  }

  async provision({ account_id: accountId, bot_token: botToken, inbound_url: inboundUrl }) {
    this.assertAccountId(accountId);
    if (typeof botToken !== 'string' || !botToken.trim()) {
      throw new HttpError(400, 'bot_token is required', 'bot_token_required');
    }
    const cleanToken = botToken.trim();
    const cleanInbound = validateInboundUrl(inboundUrl);
    const webhookUrl = this.webhookUrl(accountId);
    const existing = await this.store.getAccount(accountId);
    const client = this.telegramFactory(cleanToken);

    let bot;
    try {
      bot = await client.getMe();
    } catch (error) {
      if (error?.status === 401 || error?.code === 401) {
        throw new HttpError(400, 'Telegram rejected bot_token', 'invalid_bot_token');
      }
      throw new HttpError(502, 'Telegram token validation unavailable', 'telegram_unavailable');
    }
    const owner = await this.store.findActiveAccountByBotId(bot.id);
    if (owner && owner.account_id !== accountId) {
      throw new HttpError(409, 'Telegram bot is already connected', 'bot_already_connected');
    }

    let webhookSecret;
    let sharedSecret;
    let botEncrypted;
    let webhookEncrypted;
    let sharedEncrypted;
    let rotated = false;
    if (existing && existing.enabled
        && this.decryptRow(existing).botToken === cleanToken) {
      const current = this.decryptRow(existing);
      webhookSecret = current.webhookSecret;
      botEncrypted = encryptedFromRow(existing, 'bot_token');
      webhookEncrypted = encryptedFromRow(existing, 'webhook_secret');
      sharedEncrypted = encryptedFromRow(existing, 'shared_secret');
      sharedSecret = current.sharedSecret;
    } else {
      webhookSecret = generateSecret(24);
      sharedSecret = generateSecret(32);
      botEncrypted = encryptSecret(this.key, cleanToken);
      webhookEncrypted = encryptSecret(this.key, webhookSecret);
      sharedEncrypted = encryptSecret(this.key, sharedSecret);
      rotated = Boolean(existing);
    }

    try {
      await client.setWebhook({
        url: webhookUrl,
        secret_token: webhookSecret,
        allowed_updates: ALLOWED_UPDATES,
      });
    } catch {
      throw new HttpError(502, 'Telegram webhook registration failed', 'webhook_setup_failed');
    }
    let webhookInfo;
    try {
      webhookInfo = await client.getWebhookInfo();
    } catch {
      throw new HttpError(502, 'Telegram webhook verification failed', 'webhook_verify_failed');
    }
    if (webhookInfo?.url !== webhookUrl) {
      throw new HttpError(502, 'Telegram webhook verification failed', 'webhook_verify_failed');
    }

    let row;
    try {
      row = await this.store.upsertAccount({
        account_id: accountId,
        bot_token: botEncrypted,
        webhook_secret: webhookEncrypted,
        shared_secret: sharedEncrypted,
        inbound_url: cleanInbound,
        bot_id: bot.id,
        bot_username: bot.username,
        bot_name: [bot.first_name, bot.last_name].filter(Boolean).join(' ') || null,
        can_join_groups: bot.can_join_groups ?? null,
        can_read_all_group_messages: bot.can_read_all_group_messages ?? null,
        supports_inline_queries: bot.supports_inline_queries ?? null,
        status: 'active',
        webhook_info: webhookInfo,
      });
    } catch (error) {
      if (error?.code === '23505') {
        throw new HttpError(409, 'Telegram bot is already connected', 'bot_already_connected');
      }
      throw error;
    }
    await this.store.updateTelegramState(accountId, bot, webhookInfo);
    return {
      account: accountMetadata(row),
      shared_secret: sharedSecret,
      created: !existing,
      rotated,
    };
  }

  async patch(accountId, patch) {
    this.assertAccountId(accountId);
    const existing = await this.store.getAccount(accountId);
    if (!existing) throw new HttpError(404, 'account not found', 'account_not_found');
    const hasToken = typeof patch?.bot_token === 'string' && Boolean(patch.bot_token.trim());
    const hasInbound = typeof patch?.inbound_url === 'string' && Boolean(patch.inbound_url.trim());
    if (!hasToken && !hasInbound) {
      throw new HttpError(400, 'inbound_url or bot_token is required', 'empty_patch');
    }
    if (hasToken) {
      return this.provision({
        account_id: accountId,
        bot_token: patch.bot_token,
        inbound_url: hasInbound ? patch.inbound_url : existing.inbound_url,
      });
    }
    const row = await this.store.updateAccountInbound(
      accountId,
      validateInboundUrl(patch.inbound_url),
    );
    return { account: accountMetadata(row), shared_secret: undefined, created: false, rotated: false };
  }

  async disable(accountId) {
    const runtime = await this.getRuntime(accountId, { enabledOnly: false });
    if (!runtime.account.enabled) return accountMetadata(runtime.account);
    try {
      await runtime.client.deleteWebhook({ drop_pending_updates: false });
    } catch {
      throw new HttpError(502, 'Telegram webhook deletion failed', 'webhook_delete_failed');
    }
    const webhook = await runtime.client.getWebhookInfo().catch(() => ({ url: '' }));
    return accountMetadata(await this.store.disableAccount(accountId, webhook));
  }

  async seedLegacy({ botToken, webhookSecret, sharedSecret, inboundUrl, bot, webhook }) {
    const existing = await this.store.getAccount('default');
    if (existing && existing.enabled) return accountMetadata(existing);
    const row = await this.store.upsertAccount({
      account_id: 'default',
      bot_token: encryptSecret(this.key, botToken),
      webhook_secret: encryptSecret(this.key, webhookSecret),
      shared_secret: encryptSecret(this.key, sharedSecret),
      inbound_url: validateInboundUrl(inboundUrl),
      bot_id: bot.id,
      bot_username: bot.username,
      bot_name: [bot.first_name, bot.last_name].filter(Boolean).join(' ') || null,
      can_join_groups: bot.can_join_groups ?? null,
      can_read_all_group_messages: bot.can_read_all_group_messages ?? null,
      supports_inline_queries: bot.supports_inline_queries ?? null,
      status: 'active',
      webhook_info: webhook,
    });
    await this.store.updateTelegramState('default', bot, webhook);
    return accountMetadata(row);
  }

  async listMetadata() {
    return (await this.store.getAccountMetadataRows()).map(accountMetadata);
  }

  async getMetadata(accountId) {
    this.assertAccountId(accountId);
    const row = await this.store.getAccount(accountId);
    if (!row) throw new HttpError(404, 'account not found', 'account_not_found');
    return accountMetadata(row);
  }
}
