import { sign } from './hmac.js';

export async function forwardInbound(
  envelope,
  {
    url,
    secret,
    attempts = 2,
    timeoutMs = 120000,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
) {
  const rawBody = Buffer.from(JSON.stringify(envelope));
  let lastError;
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    attemptsMade = attempt;
    const auth = sign(secret, rawBody);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tg-timestamp': auth.timestamp,
          'x-tg-signature': auth.signature,
        },
        body: rawBody,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return { ok: true, attempts: attempt };
      lastError = `inbound HTTP ${response.status}`;
      if (response.status < 500) break;
    } catch (error) {
      lastError = error?.message || String(error);
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') break;
    }
    if (attempt < attempts) await sleep(250 * attempt);
  }

  return { ok: false, attempts: attemptsMade, error: lastError || 'inbound forward failed' };
}
