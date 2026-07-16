import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

export function parseEncryptionKey(value) {
  const raw = String(value ?? '').trim();
  let key;
  if (/^[a-f0-9]{64}$/i.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    key = Buffer.from(raw, 'base64');
  }
  if (key.length !== 32) {
    throw new Error('TELEGRAM_TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex or base64)');
  }
  return key;
}

export function encryptSecret(key, plaintext) {
  if (typeof plaintext !== 'string' || !plaintext) {
    throw new TypeError('secret plaintext must be a non-empty string');
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptSecret(key, encrypted) {
  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(encrypted.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('encrypted credential authentication failed');
  }
}

export function generateSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}
