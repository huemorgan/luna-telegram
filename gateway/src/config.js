function required(name, env) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function optional(name, fallback, env) {
  const value = env[name]?.trim();
  return value || fallback;
}

export function loadConfig(env = process.env) {
  const legacy = {
    botToken: optional('TELEGRAM_BOT_TOKEN', '', env),
    webhookSecret: optional('TELEGRAM_WEBHOOK_SECRET', '', env),
    sharedSecret: optional('TG_SHARED_SECRET', '', env),
    inboundUrl: optional('LUNA_INBOUND_URL', '', env),
  };
  const legacyValues = Object.values(legacy);
  if (legacyValues.some(Boolean) && !legacyValues.every(Boolean)) {
    throw new Error(
      'Legacy default account requires TELEGRAM_BOT_TOKEN, '
      + 'TELEGRAM_WEBHOOK_SECRET, TG_SHARED_SECRET, and LUNA_INBOUND_URL together',
    );
  }

  return {
    port: Number.parseInt(optional('PORT', '10000', env), 10),
    adminKey: required('GATEWAY_ADMIN_KEY', env),
    databaseUrl: required('DATABASE_URL', env),
    encryptionKey: required('TELEGRAM_TOKEN_ENCRYPTION_KEY', env),
    publicUrl: optional('PUBLIC_URL', '', env).replace(/\/+$/, ''),
    telegramApiBase: optional('TELEGRAM_API_BASE', 'https://api.telegram.org', env).replace(/\/+$/, ''),
    forwardAttempts: Number.parseInt(optional('TG_FORWARD_ATTEMPTS', '2', env), 10),
    forwardTimeoutMs: Number.parseInt(optional('TG_FORWARD_TIMEOUT_MS', '120000', env), 10),
    telegramTimeoutMs: Number.parseInt(optional('TELEGRAM_API_TIMEOUT_MS', '30000', env), 10),
    legacy: legacyValues.every(Boolean) ? legacy : null,
  };
}
