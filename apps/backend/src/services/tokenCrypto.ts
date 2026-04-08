/**
 * Symmetric encryption helper for at-rest protection of portal tokens
 * stored in AppSettings (accessToken / refreshToken / applicationToken).
 *
 * Design:
 *  - AES-256-GCM (authenticated encryption) via node:crypto.
 *  - Key material:
 *      1) TOKEN_ENCRYPTION_KEY env var — raw 32 bytes (base64 or hex), or
 *      2) fallback: HKDF-SHA256 derived from B24_APP_SECRET so existing
 *         installs pick up encryption without a new config step.
 *  - Wire format: `enc:v1:<ivB64>:<tagB64>:<cipherB64>` — the `enc:v1:`
 *    prefix makes decryption idempotent: legacy plaintext rows (written
 *    before this module existed) are returned as-is and transparently
 *    re-encrypted on the next write.
 *
 * This module is read/write-only via portalAuth.ts so the crypto logic
 * lives in a single place and can be swapped without touching call sites.
 */

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV is the GCM recommendation
const KEY_LENGTH = 32; // 256-bit key
const PREFIX = 'enc:v1:';

let cachedKey: Buffer | null = null;

/**
 * Resolve the symmetric key used for token encryption. Memoized.
 *
 * Prefers an explicit `TOKEN_ENCRYPTION_KEY` (32 bytes encoded as base64
 * or hex). If absent, derives a stable 32-byte key from `B24_APP_SECRET`
 * via HKDF-SHA256 so the feature works out of the box on existing
 * installs that only have the app secret configured.
 */
function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (raw && raw.length > 0) {
    // Accept base64 or hex. Try base64 first (more common for 32-byte
    // secrets); if the decoded length is wrong, fall back to hex.
    let buf: Buffer | null = null;
    try {
      const b = Buffer.from(raw, 'base64');
      if (b.length === KEY_LENGTH) buf = b;
    } catch {
      /* ignore */
    }
    if (!buf) {
      try {
        const h = Buffer.from(raw, 'hex');
        if (h.length === KEY_LENGTH) buf = h;
      } catch {
        /* ignore */
      }
    }
    if (!buf) {
      throw new Error(
        'TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as base64 or hex',
      );
    }
    cachedKey = buf;
    return buf;
  }

  const appSecret = process.env.B24_APP_SECRET;
  if (!appSecret || appSecret.length === 0) {
    throw new Error(
      'Token encryption key unavailable: set TOKEN_ENCRYPTION_KEY or B24_APP_SECRET in the backend env',
    );
  }

  // Deterministic HKDF derivation — same secret → same key across restarts.
  const derived = hkdfSync(
    'sha256',
    Buffer.from(appSecret, 'utf-8'),
    Buffer.alloc(0), // no salt — we want determinism across installs
    Buffer.from('b24-doc-gen:token-encryption:v1', 'utf-8'),
    KEY_LENGTH,
  );
  cachedKey = Buffer.from(derived);
  return cachedKey;
}

/**
 * Encrypt a token string for storage. Returns a self-describing string
 * that `decryptToken` can later parse. Empty / null input passes through
 * untouched so callers can forward optional fields without branching.
 */
export function encryptToken(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === '') return null;
  // Already encrypted — keep idempotent so double-encryption is impossible
  // even if a caller accidentally wraps twice.
  if (plain.startsWith(PREFIX)) return plain;

  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, 'utf-8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/**
 * Decrypt a token previously produced by `encryptToken`. Values that do
 * not carry the `enc:v1:` prefix are assumed to be legacy plaintext and
 * returned as-is — this lets pre-existing DB rows keep working without a
 * migration step; they get re-encrypted on the next write.
 */
export function decryptToken(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined || stored === '') return null;
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext row

  const body = stored.slice(PREFIX.length);
  const parts = body.split(':');
  if (parts.length !== 3) {
    throw new Error('decryptToken: malformed ciphertext (expected iv:tag:data)');
  }
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  if (iv.length !== IV_LENGTH) {
    throw new Error(`decryptToken: IV length mismatch (${iv.length} != ${IV_LENGTH})`);
  }

  const key = getKey();
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return plain.toString('utf-8');
}

/** Test-only: reset the memoized key so env changes take effect. */
export function __resetTokenCryptoCacheForTests(): void {
  cachedKey = null;
}
