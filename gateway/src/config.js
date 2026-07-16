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
  return {
    port: Number.parseInt(optional('PORT', '10000', env), 10),
    account: 'default',
    botToken: required('TELEGRAM_BOT_TOKEN', env),
    webhookSecret: required('TELEGRAM_WEBHOOK_SECRET', env),
    sharedSecret: required('TG_SHARED_SECRET', env),
    adminKey: required('GATEWAY_ADMIN_KEY', env),
    lunaInboundUrl: required('LUNA_INBOUND_URL', env),
    databaseUrl: required('DATABASE_URL', env),
    publicUrl: optional('PUBLIC_URL', '', env).replace(/\/+$/, ''),
    telegramApiBase: optional('TELEGRAM_API_BASE', 'https://api.telegram.org', env).replace(/\/+$/, ''),
    forwardAttempts: Number.parseInt(optional('TG_FORWARD_ATTEMPTS', '2', env), 10),
    forwardTimeoutMs: Number.parseInt(optional('TG_FORWARD_TIMEOUT_MS', '120000', env), 10),
    telegramTimeoutMs: Number.parseInt(optional('TELEGRAM_API_TIMEOUT_MS', '30000', env), 10),
  };
}
