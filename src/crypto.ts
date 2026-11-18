/**
 * Cryptographic helpers built only on node:crypto.
 *
 * - Google refresh tokens are stored encrypted with AES-256-GCM. The ciphertext
 *   carries a short key id so the key can be rotated (see README).
 * - Tokens issued to Claude are random and stored only as SHA-256 hashes.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';

export function keyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, keyId(key), iv.toString('base64url'), ct.toString('base64url'), tag.toString('base64url')].join('.');
}

export class DecryptError extends Error {}

/** Which key id a ciphertext was produced with. */
export function ciphertextKeyId(blob: string): string | undefined {
  const parts = blob.split('.');
  return parts.length === 5 && parts[0] === VERSION ? parts[1] : undefined;
}

export function decrypt(blob: string, keys: Buffer[]): string {
  const parts = blob.split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) throw new DecryptError('Unrecognized ciphertext format');
  const [, kid, ivB64, ctB64, tagB64] = parts as [string, string, string, string, string];
  const key = keys.find((k) => keyId(k) === kid);
  if (!key) throw new DecryptError(`No encryption key with id ${kid} is configured`);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new DecryptError('Ciphertext failed authentication');
  }
}

/**
 * A key for one purpose derived from a master key (HKDF-SHA256), so one secret never encrypts two kinds of data.
 * The "google-connector" prefix is the project's first name, kept on purpose: changing it would make every
 * existing install's data unreadable.
 */
export function deriveKey(master: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `google-connector ${purpose}`, 32));
}

const BYTES_VERSION = 1;

/**
 * AES-256-GCM for binary data: version (1 byte) | key id (4 bytes) | iv (12) | ciphertext | tag (16).
 * `context` is authenticated but not stored (associated data): the same context must be given to
 * decrypt, so a blob copied to another record or field fails instead of passing for that one.
 */
export function encryptBytes(plaintext: Uint8Array, key: Buffer, context = ''): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([BYTES_VERSION]), Buffer.from(keyId(key), 'hex'), iv, ct, cipher.getAuthTag()]);
}

/** Key id (hex) a blob from encryptBytes was made with, or undefined for another format. */
export function bytesKeyId(blob: Uint8Array): string | undefined {
  return blob.length >= 5 && blob[0] === BYTES_VERSION ? Buffer.from(blob.subarray(1, 5)).toString('hex') : undefined;
}

export function decryptBytes(blob: Uint8Array, keys: Buffer[], context = ''): Buffer {
  const b = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  if (b.length < 1 + 4 + 12 + 16 || b[0] !== BYTES_VERSION) throw new DecryptError('Unrecognized ciphertext format');
  const kid = b.subarray(1, 5).toString('hex');
  const key = keys.find((k) => keyId(k) === kid);
  if (!key) throw new DecryptError(`No encryption key with id ${kid} is configured`);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, b.subarray(5, 17));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(b.subarray(b.length - 16));
    return Buffer.concat([decipher.update(b.subarray(17, b.length - 16)), decipher.final()]);
  } catch {
    throw new DecryptError('Ciphertext failed authentication');
  }
}

/** URL-safe random string with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hmacHex(secret: Buffer, value: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
