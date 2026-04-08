/**
 * Bitrix24 auth middleware for the Fastify backend.
 *
 * Every `/api/*` request (except a small public allow-list) must
 * carry the iframe SDK's auth payload. We expect three headers to be
 * sent by the frontend (see `lib/b24.ts::getB24AuthHeaders`):
 *
 *  - `X-B24-Access-Token` — the OAuth access_token
 *  - `X-B24-Member-Id`    — stable portal member_id (32-char hex)
 *  - `X-B24-Domain`       — portal domain, e.g. example.bitrix24.ru
 *
 * The middleware:
 *
 *  1. Extracts and normalizes the headers (also accepts a JSON body
 *     field `auth` for webhook-style calls, e.g. the install flow
 *     when placement.bind is invoked server-side).
 *  2. Does lightweight sanity validation (all three fields present,
 *     domain looks like a Bitrix24 host, access token non-empty).
 *  3. Optionally verifies a HMAC signature of `memberId + domain`
 *     when `B24_APP_SECRET` is set. This is a weak check — the
 *     strongest guarantee is that the access token works against
 *     Bitrix24's REST API, but we avoid a live API call on every
 *     request for performance.
 *  4. Populates `request.b24Auth` with `{ userId, domain, accessToken,
 *     memberId }` for downstream handlers.
 *
 * On failure the hook throws `app.httpErrors.unauthorized(...)` which
 * fastify-sensible converts to a structured 401 JSON response.
 */

import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { B24Client } from '../services/b24Client.js';

/**
 * In-memory cache: memberId → userId. The B24 user.current REST call
 * is the only way for us to know which portal user opened the iframe
 * (the SDK doesn't expose it via the auth payload). Cached for 5
 * minutes to avoid hitting the REST API on every request.
 */
const userIdCache = new Map<string, { userId: number; loadedAt: number }>();
const USER_ID_CACHE_TTL_MS = 5 * 60 * 1000;

async function resolveUserIdFromB24(
  memberId: string,
  domain: string,
  accessToken: string,
): Promise<number> {
  const cached = userIdCache.get(memberId);
  const now = Date.now();
  if (cached && now - cached.loadedAt < USER_ID_CACHE_TTL_MS) {
    return cached.userId;
  }
  try {
    const client = new B24Client({ portal: domain, accessToken });
    const result = (await client.callMethod<{ ID?: string | number; id?: string | number }>(
      'user.current',
      {},
    )) as { ID?: string | number; id?: string | number } | null;
    const raw = result?.ID ?? result?.id ?? 0;
    const userId = Number(raw) || 0;
    if (userId > 0) {
      userIdCache.set(memberId, { userId, loadedAt: now });
    }
    return userId;
  } catch {
    return 0;
  }
}

/** Shape attached to every authenticated request. */
export interface B24RequestAuth {
  /**
   * Resolved user id. May be 0 if we could not read it from the
   * token payload (we keep the request going — route handlers that
   * need a real user id must validate it themselves).
   */
  userId: number;
  /** Portal domain, e.g. "example.bitrix24.ru". */
  domain: string;
  /** Access token (used by b24Client for REST calls). */
  accessToken: string;
  /** Portal member id, stable across logins. */
  memberId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    b24Auth?: B24RequestAuth;
  }
}

/**
 * Request bodies may carry `auth` as either a string (access token)
 * or an object mirroring the iframe payload. We accept both shapes.
 */
interface BodyAuthShape {
  access_token?: string;
  accessToken?: string;
  member_id?: string;
  memberId?: string;
  domain?: string;
  user_id?: number | string;
  userId?: number | string;
}

/**
 * Extract auth candidates from either the headers or the request
 * body. Headers take precedence when both are present.
 */
function readAuthCandidates(request: FastifyRequest): {
  accessToken?: string;
  memberId?: string;
  domain?: string;
  userId?: number;
} {
  const headers = request.headers;
  const headerAccess = readHeader(headers['x-b24-access-token']);
  const headerMember = readHeader(headers['x-b24-member-id']);
  const headerDomain = readHeader(headers['x-b24-domain']);
  const headerUserId = Number(readHeader(headers['x-b24-user-id']) ?? NaN);

  if (headerAccess && headerMember && headerDomain) {
    return {
      accessToken: headerAccess,
      memberId: headerMember,
      domain: headerDomain,
      userId: Number.isFinite(headerUserId) ? headerUserId : undefined,
    };
  }

  // Fall back to body-provided auth (install flow / server-to-server).
  const body = request.body as { auth?: string | BodyAuthShape } | undefined;
  if (body && body.auth) {
    if (typeof body.auth === 'string') {
      return { accessToken: body.auth };
    }
    const obj = body.auth;
    const uidRaw = obj.userId ?? obj.user_id;
    const uid = Number(uidRaw ?? NaN);
    return {
      accessToken: obj.accessToken ?? obj.access_token,
      memberId: obj.memberId ?? obj.member_id,
      domain: obj.domain,
      userId: Number.isFinite(uid) ? uid : undefined,
    };
  }

  return {};
}

function readHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Verifies the received auth payload. Currently this is a sanity
 * check — all three fields must be present and the domain must look
 * like a Bitrix24 host. If `B24_APP_SECRET` is set and the request
 * carries an `X-B24-Signature` header, we also validate a HMAC-SHA256
 * over `memberId + ':' + domain`.
 */
export function verifyB24Payload(candidate: {
  accessToken?: string;
  memberId?: string;
  domain?: string;
  signature?: string;
}): { ok: true; accessToken: string; memberId: string; domain: string } | { ok: false; reason: string } {
  const { accessToken, memberId, domain, signature } = candidate;

  if (!accessToken || typeof accessToken !== 'string' || accessToken.length < 8) {
    return { ok: false, reason: 'missing or invalid access token' };
  }
  if (!memberId || typeof memberId !== 'string' || memberId.length < 8) {
    return { ok: false, reason: 'missing or invalid member id' };
  }
  if (!domain || typeof domain !== 'string') {
    return { ok: false, reason: 'missing domain' };
  }
  if (!isPlausibleBitrixDomain(domain)) {
    return { ok: false, reason: 'domain is not a bitrix24 host' };
  }

  const secret = process.env.B24_APP_SECRET;
  if (secret && signature) {
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${memberId}:${domain}`)
      .digest('hex');
    if (
      expected.length !== signature.length ||
      !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
    ) {
      return { ok: false, reason: 'signature mismatch' };
    }
  }

  return { ok: true, accessToken, memberId, domain };
}

/**
 * Returns true if the value looks like a Bitrix24 portal domain.
 * Accepts `*.bitrix24.{ru,com,de,…}`, `*.bitrix.{ru,…}`, and explicit
 * domains configured via `B24_ALLOWED_DOMAINS` env var (comma-separated).
 * Also strips an optional `https?://` scheme and trailing slash.
 */
export function isPlausibleBitrixDomain(value: string): boolean {
  if (!value) return false;
  // Normalize: strip scheme, port, path and trailing slash.
  const trimmed = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');

  const envAllow = (process.env.B24_ALLOWED_DOMAINS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (envAllow.includes(trimmed)) return true;

  // Accept *.bitrix24.{tld}, *.bitrix.{tld} and any subdomain combination.
  if (/\.bitrix24\.[a-z]{2,}$/.test(trimmed)) return true;
  if (/\.bitrix\.[a-z]{2,}$/.test(trimmed)) return true;
  // Accept self-hosted bitrix-on-premise patterns like crm.example.com when
  // explicitly allowlisted via env (handled above). Otherwise reject.
  return false;
}

/**
 * Paths that do NOT require authentication. Uses startsWith matching
 * on the raw URL path.
 */
const PUBLIC_PATHS = ['/health', '/api/health'];

function isPublicPath(url: string): boolean {
  const pathname = url.split('?')[0] ?? '';
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Register the auth preHandler hook on the given Fastify instance.
 * All `/api/*` requests (except public paths) will be gated by this
 * hook. Call once from `buildServer()`.
 */
export function registerAuthMiddleware(app: FastifyInstance): void {
  app.addHook('preHandler', async (request: FastifyRequest, _reply: FastifyReply) => {
    const url = request.url;
    // Only protect /api/* routes. Other endpoints (health, placements
    // registered directly on the root) are left alone.
    if (!url.startsWith('/api/')) return;
    if (isPublicPath(url)) return;

    const candidates = readAuthCandidates(request);
    const headerSig = readHeader(request.headers['x-b24-signature']);
    const verification = verifyB24Payload({ ...candidates, signature: headerSig });

    if (!verification.ok) {
      request.log.warn(
        {
          reason: verification.reason,
          url,
          receivedDomain: candidates.domain ?? null,
          hasAccessToken: Boolean(candidates.accessToken),
          hasMemberId: Boolean(candidates.memberId),
        },
        'B24 auth failed',
      );
      throw app.httpErrors.unauthorized(`B24 auth failed: ${verification.reason}`);
    }

    let userId = Number.isFinite(candidates.userId) ? Number(candidates.userId) : 0;

    // If the frontend didn't supply a user id (the SDK auth payload
    // doesn't expose it), resolve it via Bitrix24 REST `user.current`.
    // The result is cached for 5 minutes per memberId.
    if (userId <= 0) {
      userId = await resolveUserIdFromB24(
        verification.memberId,
        verification.domain,
        verification.accessToken,
      );
    }

    request.b24Auth = {
      userId,
      domain: verification.domain,
      accessToken: verification.accessToken,
      memberId: verification.memberId,
    };
  });
}
