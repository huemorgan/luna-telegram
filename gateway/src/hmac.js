import crypto from 'node:crypto';

export const HMAC_SKEW_SECONDS = 300;

function bodyBuffer(rawBody) {
  return Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
}

export function sign(secret, rawBody, timestamp = Math.floor(Date.now() / 1000).toString()) {
  const ts = String(timestamp);
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${ts}.`, 'utf8');
  hmac.update(bodyBuffer(rawBody));
  return { timestamp: ts, signature: hmac.digest('hex') };
}

export function verify(
  secret,
  rawBody,
  timestamp,
  signature,
  { now = Math.floor(Date.now() / 1000), skewSeconds = HMAC_SKEW_SECONDS } = {},
) {
  if (!timestamp || !signature || !/^\d+$/.test(String(timestamp))) return false;
  if (Math.abs(now - Number(timestamp)) > skewSeconds) return false;
  if (!/^[a-f0-9]{64}$/i.test(String(signature))) return false;

  const expected = sign(secret, rawBody, String(timestamp)).signature;
  const actualBytes = Buffer.from(String(signature).toLowerCase(), 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');
  return actualBytes.length === expectedBytes.length
    && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

export function timingSafeTextEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length
    && crypto.timingSafeEqual(actualBytes, expectedBytes);
}
