const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_HASH_BYTES = 32;
const PBKDF2_SALT_BYTES = 16;

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

function fromHex(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Pure-TS constant-time XOR comparison safe for Cloudflare Workers and Node.
 */
export function constantTimeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const ab = typeof a === 'string' ? encoder.encode(a) : a;
  const bb = typeof b === 'string' ? encoder.encode(b) : b;
  const maxLen = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < maxLen; i++) {
    const av = i < ab.length ? ab[i]! : 0;
    const bv = i < bb.length ? bb[i]! : 0;
    diff |= av ^ bv;
  }
  return diff === 0;
}

export function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export function generateId(prefix: string): string {
  return `${prefix}_${randomHex(8)}`;
}

export function generateSessionToken(): string {
  return `sess_${randomHex(24)}`;
}

export function generateApiKey(): string {
  return `ak_live_${randomHex(20)}`;
}

export function generateDeviceApiKey(): string {
  return `ak_dev_${randomHex(20)}`;
}

async function deriveAesGcmKey(secret: string, usage: 'encrypt' | 'decrypt') {
  const keyHash = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey('raw', keyHash, 'AES-GCM', false, [usage]);
}

/**
 * Seals a device-bound API key for reversible server-side lookup via AES-256-GCM
 * when an encryption secret is configured, or falls back to tagged plaintext.
 */
export async function sealApiKeySecret(rawKey: string, secret?: string): Promise<string> {
  const trimmedSecret = secret?.trim();
  if (!trimmedSecret) {
    return `plain:${rawKey}`;
  }
  const aesKey = await deriveAesGcmKey(trimmedSecret, 'encrypt');
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    encoder.encode(rawKey),
  );
  return `enc1:${toHex(iv)}:${toHex(new Uint8Array(cipherBuf))}`;
}

/**
 * Unseals a stored device-bound API key secret; returns null if missing or invalid.
 */
export async function unsealApiKeySecret(
  stored: string | null | undefined,
  secret?: string,
): Promise<string | null> {
  if (!stored) return null;
  if (stored.startsWith('plain:')) {
    const raw = stored.slice('plain:'.length);
    return raw ? raw : null;
  }
  if (stored.startsWith('enc1:')) {
    const trimmedSecret = secret?.trim();
    if (!trimmedSecret) return null;
    const parts = stored.split(':');
    if (parts.length !== 3) return null;
    const iv = fromHex(parts[1] ?? '');
    const cipher = fromHex(parts[2] ?? '');
    if (!iv || iv.byteLength !== 12 || !cipher || cipher.byteLength === 0) {
      return null;
    }
    try {
      const aesKey = await deriveAesGcmKey(trimmedSecret, 'decrypt');
      const plainBuf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(iv) },
        aesKey,
        new Uint8Array(cipher),
      );
      const plain = decoder.decode(plainBuf);
      return plain ? plain : null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return toHex(new Uint8Array(digest));
}

async function derivePbkdf2Hex(
  password: string,
  salt: Uint8Array,
  iterations: number,
  keyBytes: number,
): Promise<string> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const saltCopy = new Uint8Array(salt);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltCopy,
      iterations,
      hash: 'SHA-256',
    },
    baseKey,
    keyBytes * 8,
  );
  return toHex(new Uint8Array(bits));
}

/**
 * Hashes password with PBKDF2-SHA256 at exact 100,000 iterations (CF Worker safe).
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(PBKDF2_SALT_BYTES);
  crypto.getRandomValues(salt);
  const hashHex = await derivePbkdf2Hex(password, salt, PBKDF2_ITERATIONS, PBKDF2_HASH_BYTES);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt)}$${hashHex}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') {
    return false;
  }
  const iterations = Number.parseInt(parts[1] ?? '', 10);
  if (!Number.isFinite(iterations) || iterations <= 0 || iterations > PBKDF2_ITERATIONS) {
    return false;
  }
  const salt = fromHex(parts[2] ?? '');
  const expected = fromHex(parts[3] ?? '');
  if (!salt || !expected || expected.length === 0) {
    return false;
  }
  const derivedHex = await derivePbkdf2Hex(password, salt, iterations, expected.length);
  const derived = fromHex(derivedHex);
  if (!derived) return false;
  return constantTimeEqual(derived, expected);
}
