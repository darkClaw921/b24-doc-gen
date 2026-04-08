/**
 * Install routes — handle the first-run setup of the application.
 *
 *  - `GET /api/install/status` — returns `{ installed: bool, adminUserIds, dealFieldBinding, portalDomain }`.
 *  - `POST /api/install`        — upserts the singleton `AppSettings`
 *    record (id = 1) with the admin user IDs and optional UF_CRM
 *    field binding. The portal domain is taken from the verified
 *    `request.b24Auth.domain` so the client cannot spoof it.
 *  - `POST /api/install/register-placements` — calls `placement.bind`
 *    to register the CRM_DEAL_DETAIL_TAB and DEFAULT placements
 *    (this lives next to install for cohesion; see x0t.7).
 *
 * The `AppSettings` model in Prisma stores `adminUserIds` as a
 * JSON-encoded string because SQLite has no native array column;
 * we marshal/unmarshal here.
 */

import type { FastifyInstance } from 'fastify';
import type { AppSettings as PrismaAppSettings } from '@prisma/client';
import type { AppSettings } from '@b24-doc-gen/shared';
import { prisma } from '../prisma/client.js';
import { B24Client, B24Error } from '../services/b24Client.js';
import { invalidateRoleCache } from '../middleware/role.js';

interface InstallBody {
  adminUserIds: number[];
  dealFieldBinding?: string | null;
}

interface RegisterPlacementsBody {
  /** Public URL of the frontend (https://...) used as the iframe src. */
  handlerUrl?: string;
}

/** Returned by `GET /api/install/status`. */
export interface InstallStatusResponse {
  installed: boolean;
  adminUserIds: number[];
  dealFieldBinding: string | null;
  portalDomain: string | null;
  installedAt: string | null;
}

/**
 * Convert a Prisma row into the public `AppSettings` shape used by
 * the shared types package. The DB stores `adminUserIds` as JSON.
 */
export function toAppSettings(row: PrismaAppSettings): AppSettings {
  let parsed: number[] = [];
  try {
    const arr = JSON.parse(row.adminUserIds);
    if (Array.isArray(arr)) {
      parsed = arr.map((n) => Number(n)).filter((n) => Number.isFinite(n));
    }
  } catch {
    parsed = [];
  }
  return {
    id: row.id,
    portalDomain: row.portalDomain,
    adminUserIds: parsed,
    dealFieldBinding: row.dealFieldBinding,
    installedAt: row.installedAt.toISOString(),
  };
}

export async function registerInstallRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------------------------------------------------------- */
  /* GET /api/install/status                                           */
  /* ---------------------------------------------------------------- */
  app.get('/api/install/status', async (): Promise<InstallStatusResponse> => {
    const row = await prisma.appSettings.findUnique({ where: { id: 1 } });
    if (!row) {
      return {
        installed: false,
        adminUserIds: [],
        dealFieldBinding: null,
        portalDomain: null,
        installedAt: null,
      };
    }
    const settings = toAppSettings(row);
    return {
      installed: true,
      adminUserIds: settings.adminUserIds,
      dealFieldBinding: settings.dealFieldBinding,
      portalDomain: settings.portalDomain,
      installedAt: settings.installedAt,
    };
  });

  /* ---------------------------------------------------------------- */
  /* POST /api/install                                                 */
  /* ---------------------------------------------------------------- */
  app.post<{ Body: InstallBody }>('/api/install', async (request, reply) => {
    const auth = request.b24Auth;
    if (!auth) return reply.unauthorized('B24 auth payload missing');

    const body = request.body ?? ({} as InstallBody);
    if (!Array.isArray(body.adminUserIds) || body.adminUserIds.length === 0) {
      return reply.badRequest('adminUserIds must be a non-empty array of numbers');
    }

    const sanitized = Array.from(
      new Set(body.adminUserIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)),
    );
    if (sanitized.length === 0) {
      return reply.badRequest('adminUserIds contains no valid numeric ids');
    }

    const dealFieldBinding =
      typeof body.dealFieldBinding === 'string' && body.dealFieldBinding.length > 0
        ? body.dealFieldBinding
        : null;

    const row = await prisma.appSettings.upsert({
      where: { id: 1 },
      update: {
        portalDomain: auth.domain,
        adminUserIds: JSON.stringify(sanitized),
        dealFieldBinding,
      },
      create: {
        id: 1,
        portalDomain: auth.domain,
        adminUserIds: JSON.stringify(sanitized),
        dealFieldBinding,
      },
    });

    // Admin list just changed — drop cached role lookups so the next
    // requireAdmin() call sees the freshly installed admin set.
    invalidateRoleCache();

    return { settings: toAppSettings(row) };
  });

  /* ---------------------------------------------------------------- */
  /* POST /api/install/register-placements                             */
  /* ---------------------------------------------------------------- */
  app.post<{ Body: RegisterPlacementsBody }>(
    '/api/install/register-placements',
    async (request, reply) => {
      const auth = request.b24Auth;
      if (!auth) return reply.unauthorized('B24 auth payload missing');

      const body = request.body ?? ({} as RegisterPlacementsBody);
      // Priority: explicit body.handlerUrl > FRONTEND_PUBLIC_URL > PUBLIC_URL
      // (the ngrok/cloudflared tunnel that backs the local app on the
      // portal) > FRONTEND_URL. We deliberately do NOT fall back to
      // http://localhost:* because Bitrix24 rejects non-HTTPS handlers
      // with ERROR_WRONG_HANDLER_URL.
      const rawHandlerUrl =
        body.handlerUrl ??
        process.env.FRONTEND_PUBLIC_URL ??
        process.env.PUBLIC_URL ??
        process.env.FRONTEND_URL ??
        '';

      if (!rawHandlerUrl) {
        return reply.badRequest(
          'No public handler URL configured. Set PUBLIC_URL (or FRONTEND_PUBLIC_URL) in apps/backend/.env to your HTTPS tunnel URL.',
        );
      }
      if (!/^https:\/\//i.test(rawHandlerUrl)) {
        return reply.badRequest(
          `Handler URL must be HTTPS (Bitrix24 rejects http://). Got: ${rawHandlerUrl}. Update PUBLIC_URL in apps/backend/.env.`,
        );
      }
      // Strip trailing slash so we always build clean URLs.
      const handlerUrl = rawHandlerUrl.replace(/\/+$/, '');

      const client = new B24Client({
        portal: auth.domain,
        accessToken: auth.accessToken,
      });

      // NOTE: `DEFAULT` is NOT a bindable placement code — it's the app's
      // main entry point, configured via the "URL обработчика" field in
      // the local app manifest on the portal. Trying to bind it via
      // placement.bind returns ERROR_ARGUMENT.
      const calls: Array<{ name: string; params: Record<string, unknown> }> = [
        {
          name: 'CRM_DEAL_DETAIL_TAB',
          params: {
            PLACEMENT: 'CRM_DEAL_DETAIL_TAB',
            HANDLER: `${handlerUrl}/?view=generate`,
            TITLE: 'Документы',
            DESCRIPTION: 'Генерация документов из шаблонов',
          },
        },
      ];

      // Diagnostic: ask the portal which placements our app is allowed
      // to bind. If CRM_DEAL_DETAIL_TAB is missing here, the local app
      // manifest doesn't declare it — placement.bind will fail silently
      // and the tab will never appear in the deal card.
      let availablePlacements: string[] = [];
      let placementListError: string | undefined;
      try {
        const list = await client.callMethod('placement.list', {});
        if (Array.isArray(list)) {
          availablePlacements = list.filter((x): x is string => typeof x === 'string');
        }
      } catch (err) {
        placementListError = err instanceof Error ? err.message : String(err);
        request.log.warn({ err: placementListError }, 'placement.list failed');
      }
      request.log.info(
        { availablePlacements, placementListError, handlerUrl },
        'register-placements: portal allowed placements',
      );

      const results: Record<string, { ok: boolean; error?: string; code?: string }> = {};
      for (const call of calls) {
        try {
          await client.callMethod('placement.bind', call.params);
          results[call.name] = { ok: true };
          request.log.info({ call: call.name }, 'placement.bind ok');
        } catch (err) {
          // Common case: ERROR_PLACEMENT_ALREADY_BOUND — treat as success.
          const code = err instanceof B24Error ? err.code : 'UNKNOWN';
          if (
            code === 'ERROR_PLACEMENT_ALREADY_BOUND' ||
            (err instanceof B24Error && /already/i.test(err.message))
          ) {
            results[call.name] = { ok: true };
            request.log.info({ call: call.name }, 'placement.bind already bound (ok)');
          } else {
            const msg = err instanceof Error ? err.message : String(err);
            results[call.name] = { ok: false, error: msg, code };
            request.log.warn(
              { call: call.name, code, err: msg, params: call.params },
              'placement.bind failed',
            );
          }
        }
      }

      return { results, availablePlacements, placementListError };
    },
  );
}
