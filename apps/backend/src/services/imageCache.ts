/**
 * imageCache — in-memory cache for base64 images.
 *
 * Stores base64 data URIs and serves them via a short hash-based URL.
 * This solves the problem where some browsers (especially inside
 * Bitrix24 iframes) refuse to render `data:image/...` URIs due to
 * Content Security Policy restrictions or size limits.
 *
 * Flow:
 *  1. Backend code calls `cacheImage(dataUri)` → gets a `/api/images/<hash>` URL.
 *  2. Frontend uses the URL in `<img src="...">`.
 *  3. The route handler decodes the hash, finds the cached buffer, and
 *     streams it with the correct Content-Type.
 *
 * Images expire after 30 minutes (configurable) to avoid unbounded
 * memory growth.
 */

import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/* ------------------------------------------------------------------ */
/* Cache store                                                         */
/* ------------------------------------------------------------------ */

interface CachedImage {
  buffer: Buffer;
  mime: string;
  expiresAt: number;
}

const cache = new Map<string, CachedImage>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Periodic cleanup interval (runs every 5 minutes). */
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (entry.expiresAt < now) {
        cache.delete(key);
      }
    }
  }, 5 * 60 * 1000);
  // Don't block process exit.
  if (cleanupTimer && typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
    cleanupTimer.unref();
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Cache a base64 data URI and return a URL path that serves it.
 *
 * @param dataUri - e.g. `data:image/png;base64,iVBOR...`
 * @returns       - URL path like `/api/images/abc123def456`
 *                  Returns empty string if the input is not a valid data URI.
 */
export function cacheImage(dataUri: string): string {
  if (!dataUri || !dataUri.startsWith('data:image/')) {
    return '';
  }

  const mimeMatch = dataUri.match(/^data:(image\/[^;]+);base64,/);
  if (!mimeMatch) return '';

  const mime = mimeMatch[1];
  const base64Data = dataUri.slice(mimeMatch[0].length);

  // Use a content-based hash so the same image always gets the same URL.
  const hash = crypto.createHash('sha256').update(base64Data).digest('hex').slice(0, 24);

  if (!cache.has(hash)) {
    const buffer = Buffer.from(base64Data, 'base64');
    cache.set(hash, {
      buffer,
      mime,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    startCleanup();
  } else {
    // Refresh expiry on access.
    const entry = cache.get(hash)!;
    entry.expiresAt = Date.now() + CACHE_TTL_MS;
  }

  return `/api/images/${hash}`;
}

/**
 * Convert all base64 `data:image/...` src attributes in an HTML string
 * to cached URL paths. This makes the HTML safe to render in browsers
 * that block data URIs.
 */
export function replaceBase64WithUrls(html: string): string {
  // Match src="data:image/..." and src='data:image/...'
  return html.replace(
    /src=["'](data:image\/[^"']+)["']/g,
    (_match, dataUri: string) => {
      const url = cacheImage(dataUri);
      return url ? `src="${url}"` : _match;
    },
  );
}

/* ------------------------------------------------------------------ */
/* Route registration                                                  */
/* ------------------------------------------------------------------ */

export async function registerImageRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { hash: string } }>('/api/images/:hash', async (request, reply) => {
    const { hash } = request.params;
    const entry = cache.get(hash);

    if (!entry) {
      return reply.notFound('Image not found or expired');
    }

    // Refresh expiry on access.
    entry.expiresAt = Date.now() + CACHE_TTL_MS;

    return reply
      .header('Content-Type', entry.mime)
      .header('Cache-Control', 'private, max-age=1800')
      .header('Content-Length', entry.buffer.length)
      .send(entry.buffer);
  });
}
