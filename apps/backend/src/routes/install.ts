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

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppSettings as PrismaAppSettings } from '@prisma/client';
import type { AppSettings } from '@b24-doc-gen/shared';
import { prisma } from '../prisma/client.js';
import { B24Client, B24Error } from '../services/b24Client.js';
import { savePortalTokens } from '../services/portalAuth.js';
import { invalidateRoleCache } from '../middleware/role.js';

interface InstallBody {
  adminUserIds: number[];
  dealFieldBinding?: string | null;
  /**
   * Full BX24 SDK auth snapshot forwarded from the frontend so the
   * backend can keep long-lived tokens for server-to-server flows
   * (primarily the webhook executor). Optional: older install flows
   * do not send it, and the upsert will still succeed, but webhook
   * calls will fail with `missing_tokens` until the admin re-opens the
   * app in the portal iframe.
   */
  oauth?: {
    accessToken: string;
    refreshToken: string;
    /** Unix seconds from the SDK (`expires` field). */
    expiresAt: number;
    memberId: string;
    domain: string;
  };
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
    addToTimeline: row.addToTimeline,
    installedAt: row.installedAt.toISOString(),
  };
}

/**
 * Catalog of CRM deal embedding locations the app exposes in the
 * Settings UI ("Места встройки"). Each entry maps a Bitrix24 placement
 * code to a friendly title/description and the `?view=` the iframe is
 * opened in. This is the single source of truth for which placements an
 * admin may bind via `POST /api/placements`.
 *
 * IMPORTANT: a code can only be bound if it's also declared in the local
 * app manifest on the portal — otherwise `placement.bind` returns an
 * error, which we surface back to the user.
 */
const DEAL_PLACEMENT_CATALOG = [
  {
    placement: 'CRM_DEAL_DETAIL_TAB',
    title: 'Документы',
    description: 'Отдельная вкладка в карточке сделки',
    view: 'generate',
  },
  {
    placement: 'CRM_DEAL_DETAIL_TOOLBAR',
    title: 'Документы',
    description: 'Кнопка на панели инструментов карточки сделки',
    view: 'generate',
  },
  {
    placement: 'CRM_DEAL_DETAIL_ACTIVITY',
    title: 'Документы',
    description: 'Действие в таймлайне сделки',
    view: 'generate',
  },
] as const;

/**
 * Resolve and validate the public HTTPS handler base URL used as the
 * iframe src for placement handlers. Priority: explicit value (from the
 * request body) > FRONTEND_PUBLIC_URL > PUBLIC_URL > FRONTEND_URL.
 *
 * Returns the cleaned base URL (no trailing slash) on success. On
 * failure it sends a 400 reply itself and returns `null`, so callers
 * must `return` early when the result is null. We deliberately reject
 * non-HTTPS URLs because Bitrix24 answers `ERROR_WRONG_HANDLER_URL`.
 */
function resolveHandlerBaseUrl(explicit: string | undefined, reply: FastifyReply): string | null {
  const raw =
    explicit ??
    process.env.FRONTEND_PUBLIC_URL ??
    process.env.PUBLIC_URL ??
    process.env.FRONTEND_URL ??
    '';

  if (!raw) {
    reply.badRequest(
      'No public handler URL configured. Set PUBLIC_URL (or FRONTEND_PUBLIC_URL) in apps/backend/.env to your HTTPS tunnel URL.',
    );
    return null;
  }
  if (!/^https:\/\//i.test(raw)) {
    reply.badRequest(
      `Handler URL must be HTTPS (Bitrix24 rejects http://). Got: ${raw}. Update PUBLIC_URL in apps/backend/.env.`,
    );
    return null;
  }
  // Strip trailing slash so we always build clean URLs.
  return raw.replace(/\/+$/, '');
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

    // If the frontend forwarded its full SDK auth snapshot, persist the
    // OAuth pair so the webhook executor (and any other server-to-server
    // caller) can act on behalf of the portal later. Best-effort: we log
    // but don't fail install if persistence hiccups, otherwise a token
    // shape change could break the primary onboarding flow.
    const oauth = body.oauth;
    if (oauth && oauth.accessToken && oauth.refreshToken && oauth.memberId && oauth.domain) {
      try {
        await savePortalTokens({
          accessToken: oauth.accessToken,
          refreshToken: oauth.refreshToken,
          expiresAt: new Date(oauth.expiresAt * 1000),
          memberId: oauth.memberId,
          domain: oauth.domain,
        });
        request.log.info(
          { memberId: oauth.memberId, domain: oauth.domain },
          'install: portal OAuth tokens captured',
        );
      } catch (err) {
        request.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'install: failed to persist portal OAuth tokens (non-fatal)',
        );
      }
    } else {
      request.log.warn(
        'install: frontend did not forward OAuth snapshot; webhook executor will be unavailable until re-install',
      );
    }

    // Admin list just changed — drop cached role lookups so the next
    // requireAdmin() call sees the freshly installed admin set.
    invalidateRoleCache();

    return { settings: toAppSettings(row) };
  });

  /* ---------------------------------------------------------------- */
  /* POST /api/install/sync-oauth                                      */
  /*                                                                    */
  /* Called by the frontend on every app open so the backend always    */
  /* has a fresh refresh_token on file for server-to-server flows      */
  /* (webhook executor). This is admin-gated at the middleware layer   */
  /* via the normal B24 preHandler — the frontend only hits it when    */
  /* the current iframe user is an app admin.                           */
  /* ---------------------------------------------------------------- */
  app.post<{
    Body: {
      oauth?: {
        accessToken: string;
        refreshToken: string;
        expiresAt: number;
        memberId: string;
        domain: string;
      };
    };
  }>('/api/install/sync-oauth', async (request, reply) => {
    const auth = request.b24Auth;
    if (!auth) return reply.unauthorized('B24 auth payload missing');

    const oauth = request.body?.oauth;
    if (
      !oauth ||
      !oauth.accessToken ||
      !oauth.refreshToken ||
      !oauth.memberId ||
      !oauth.domain ||
      typeof oauth.expiresAt !== 'number'
    ) {
      return reply.badRequest('oauth payload is incomplete');
    }

    // Safety: the SDK snapshot must belong to the currently
    // authenticated portal, otherwise an admin from one portal could
    // overwrite tokens for another install. We only have one install
    // per backend so this is a paranoid check, but cheap.
    if (oauth.domain !== auth.domain || oauth.memberId !== auth.memberId) {
      return reply.forbidden('oauth payload does not match authenticated portal');
    }

    try {
      await savePortalTokens({
        accessToken: oauth.accessToken,
        refreshToken: oauth.refreshToken,
        expiresAt: new Date(oauth.expiresAt * 1000),
        memberId: oauth.memberId,
        domain: oauth.domain,
      });
      request.log.info(
        { memberId: oauth.memberId, domain: oauth.domain },
        'sync-oauth: portal OAuth tokens updated',
      );
      return { ok: true };
    } catch (err) {
      request.log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'sync-oauth: failed to persist tokens',
      );
      return reply.internalServerError('failed to persist oauth tokens');
    }
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
      const handlerUrl = resolveHandlerBaseUrl(body.handlerUrl, reply);
      if (handlerUrl === null) return; // resolveHandlerBaseUrl already replied 400

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

  /* ---------------------------------------------------------------- */
  /* GET /api/placements — list registered placement handlers         */
  /* ---------------------------------------------------------------- */
  app.get('/api/placements', async (request, reply) => {
    const auth = request.b24Auth;
    if (!auth) return reply.unauthorized('B24 auth payload missing');

    const client = new B24Client({
      portal: auth.domain,
      accessToken: auth.accessToken,
    });

    try {
      const raw = await client.callMethod<
        Array<Record<string, unknown>>
      >('placement.get', {});
      const placements = Array.isArray(raw)
        ? raw.map((p) => ({
            placement: String(p.placement ?? p.PLACEMENT ?? ''),
            handler: String(p.handler ?? p.HANDLER ?? ''),
            title: String(p.title ?? p.TITLE ?? ''),
            description: String(p.description ?? p.DESCRIPTION ?? ''),
          }))
        : [];
      return { placements };
    } catch (err) {
      if (err instanceof B24Error) {
        return reply.badGateway(`placement.get failed: ${err.message}`);
      }
      throw err;
    }
  });

  /* ---------------------------------------------------------------- */
  /* GET /api/placements/catalog — embedding locations the app offers   */
  /*                                                                    */
  /* Drives the "выбрать куда встроить" dropdown in the Settings UI.    */
  /* Returns the static catalog of supported CRM deal placements (code  */
  /* + friendly title/description). Binding state is computed on the    */
  /* client by intersecting this with `GET /api/placements`.            */
  /* ---------------------------------------------------------------- */
  app.get('/api/placements/catalog', async (request, reply) => {
    const auth = request.b24Auth;
    if (!auth) return reply.unauthorized('B24 auth payload missing');
    return {
      catalog: DEAL_PLACEMENT_CATALOG.map((e) => ({
        placement: e.placement,
        title: e.title,
        description: e.description,
      })),
    };
  });

  /* ---------------------------------------------------------------- */
  /* POST /api/placements — bind a chosen embedding location            */
  /*                                                                    */
  /* Admin picks a placement from the catalog and embeds it (or         */
  /* re-embeds one previously removed). The placement code is validated */
  /* against DEAL_PLACEMENT_CATALOG so we never bind arbitrary codes,   */
  /* and the HANDLER URL is derived from the configured HTTPS base +    */
  /* the catalog entry's `?view=`. ERROR_PLACEMENT_ALREADY_BOUND is     */
  /* treated as success (idempotent re-embed).                          */
  /* ---------------------------------------------------------------- */
  app.post<{
    Body: { placement?: string; title?: string; description?: string; handlerUrl?: string };
  }>('/api/placements', async (request, reply) => {
    const auth = request.b24Auth;
    if (!auth) return reply.unauthorized('B24 auth payload missing');

    const body = request.body ?? {};
    const code = typeof body.placement === 'string' ? body.placement.trim() : '';
    const entry = DEAL_PLACEMENT_CATALOG.find((e) => e.placement === code);
    if (!entry) {
      return reply.badRequest(
        `Unsupported placement "${code}". Allowed: ${DEAL_PLACEMENT_CATALOG.map(
          (e) => e.placement,
        ).join(', ')}`,
      );
    }

    const base = resolveHandlerBaseUrl(body.handlerUrl, reply);
    if (base === null) return; // resolveHandlerBaseUrl already replied 400

    const title =
      typeof body.title === 'string' && body.title.trim().length > 0
        ? body.title.trim()
        : entry.title;
    const description =
      typeof body.description === 'string' && body.description.trim().length > 0
        ? body.description.trim()
        : entry.description;

    const client = new B24Client({
      portal: auth.domain,
      accessToken: auth.accessToken,
    });

    const params = {
      PLACEMENT: entry.placement,
      HANDLER: `${base}/?view=${entry.view}`,
      TITLE: title,
      DESCRIPTION: description,
    };

    try {
      await client.callMethod('placement.bind', params);
      request.log.info({ placement: entry.placement }, 'placement.bind ok (settings)');
      return { ok: true, placement: entry.placement };
    } catch (err) {
      const errCode = err instanceof B24Error ? err.code : 'UNKNOWN';
      if (
        errCode === 'ERROR_PLACEMENT_ALREADY_BOUND' ||
        (err instanceof B24Error && /already/i.test(err.message))
      ) {
        request.log.info({ placement: entry.placement }, 'placement.bind already bound (ok)');
        return { ok: true, placement: entry.placement, alreadyBound: true };
      }
      const msg = err instanceof Error ? err.message : String(err);
      request.log.warn(
        { placement: entry.placement, code: errCode, err: msg, params },
        'placement.bind failed (settings)',
      );
      if (err instanceof B24Error) {
        return reply.badGateway(`placement.bind failed: ${msg}`);
      }
      throw err;
    }
  });

  /* ---------------------------------------------------------------- */
  /* DELETE /api/placements — unbind a placement handler               */
  /* ---------------------------------------------------------------- */
  app.delete<{
    Body: { placement: string; handler: string };
  }>('/api/placements', async (request, reply) => {
    const auth = request.b24Auth;
    if (!auth) return reply.unauthorized('B24 auth payload missing');

    const body = request.body ?? ({} as { placement: string; handler: string });
    if (!body.placement || !body.handler) {
      return reply.badRequest('placement and handler are required');
    }

    const client = new B24Client({
      portal: auth.domain,
      accessToken: auth.accessToken,
    });

    try {
      await client.callMethod('placement.unbind', {
        PLACEMENT: body.placement,
        HANDLER: body.handler,
      });
      return { ok: true };
    } catch (err) {
      if (err instanceof B24Error) {
        return reply.badGateway(`placement.unbind failed: ${err.message}`);
      }
      throw err;
    }
  });
}
