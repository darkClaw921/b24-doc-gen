/**
 * Role-based access control for the b24-doc-gen backend.
 *
 * The B24 auth middleware (`middleware/auth.ts`) populates
 * `request.b24Auth.userId` with the Bitrix24 portal user id of the
 * caller. This module compares that id against the list of admin
 * user ids stored on the singleton `AppSettings` row and either lets
 * the request continue or rejects it with a 403.
 *
 * Usage on a Fastify route:
 *
 *   app.post('/api/themes', { preHandler: requireAdmin }, async (req, reply) => {
 *     // only admins reach this point
 *   });
 *
 * `requireAdmin` is exported as a Fastify preHandler so it can be
 * attached per-route via the `preHandler` option. We deliberately do
 * NOT install it as a global hook — most read endpoints (GET) must be
 * usable by both roles, so the gate is opt-in for mutation routes.
 *
 * The helper `loadCurrentRole(request)` returns the resolved role
 * without throwing — used by `GET /api/me` to tell the frontend which
 * UI elements to render.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { AppRole } from '@b24-doc-gen/shared';
import { prisma } from '../prisma/client.js';

/* ------------------------------------------------------------------ */
/* AppSettings cache                                                   */
/* ------------------------------------------------------------------ */

/**
 * AppSettings is a singleton row that changes infrequently — we keep a
 * tiny in-memory cache (TTL 30s) to avoid hitting SQLite on every
 * mutation. The cache is invalidated externally by anyone updating
 * the row (call `invalidateRoleCache()` after a settings.update).
 */
interface CachedAdmins {
  ids: Set<number>;
  loadedAt: number;
}

let adminCache: CachedAdmins | null = null;
const CACHE_TTL_MS = 30_000;

/**
 * Force-invalidate the admin cache. Call this from any code path that
 * modifies `AppSettings.adminUserIds` so the next role check refetches.
 */
export function invalidateRoleCache(): void {
  adminCache = null;
}

async function loadAdminIds(): Promise<Set<number>> {
  const now = Date.now();
  if (adminCache && now - adminCache.loadedAt < CACHE_TTL_MS) {
    return adminCache.ids;
  }
  const row = await prisma.appSettings.findUnique({ where: { id: 1 } });
  let ids: number[] = [];
  if (row) {
    try {
      const parsed = JSON.parse(row.adminUserIds) as unknown;
      if (Array.isArray(parsed)) {
        ids = parsed
          .map((n) => Number(n))
          .filter((n) => Number.isFinite(n) && n > 0);
      }
    } catch {
      ids = [];
    }
  }
  adminCache = { ids: new Set(ids), loadedAt: now };
  return adminCache.ids;
}

/* ------------------------------------------------------------------ */
/* Public helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Resolve the current role for the request. Returns 'admin' if the
 * user id from `request.b24Auth.userId` is in `AppSettings.adminUserIds`,
 * otherwise 'user'. If the request is not authenticated or AppSettings
 * is missing, returns 'user' (least privilege).
 */
export async function loadCurrentRole(request: FastifyRequest): Promise<AppRole> {
  const auth = request.b24Auth;
  if (!auth || !Number.isFinite(auth.userId) || auth.userId <= 0) {
    return 'user';
  }
  const admins = await loadAdminIds();
  return admins.has(auth.userId) ? 'admin' : 'user';
}

/**
 * Fastify preHandler that rejects with 403 if the caller is not an
 * admin. The auth hook must run first (it does — `registerAuthMiddleware`
 * uses `preHandler` and Fastify runs them in registration order, so
 * the global auth hook fires before per-route preHandlers).
 *
 * On success the middleware does nothing. On failure it throws via
 * `reply.forbidden(...)` which @fastify/sensible converts to a JSON
 * 403 envelope picked up by the central error handler.
 */
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const auth = request.b24Auth;
  if (!auth) {
    return reply.unauthorized('B24 auth payload missing');
  }
  if (!Number.isFinite(auth.userId) || auth.userId <= 0) {
    return reply.forbidden('Cannot determine current user id');
  }
  const role = await loadCurrentRole(request);
  if (role !== 'admin') {
    request.log.warn(
      { userId: auth.userId, url: request.url },
      'admin-only route blocked for non-admin user',
    );
    return reply.forbidden('Эта операция доступна только администраторам приложения');
  }
}
