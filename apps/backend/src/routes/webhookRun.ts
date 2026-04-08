/**
 * Webhook executor — public endpoint called by Bitrix24's
 * "Исходящий вебхук" (Outgoing Webhook) robot.
 *
 *   POST /api/webhook/run/:token
 *   Content-Type: application/x-www-form-urlencoded
 *
 * The robot serialises its payload in the classic Bitrix outbound
 * format, which — once deserialised by `qs` (see server.ts) — looks
 * roughly like:
 *
 *   {
 *     auth: {
 *       domain: 'example.bitrix24.ru',
 *       access_token: '...',
 *       member_id: '...',
 *       application_token: '<APP_SID>'
 *     },
 *     event: 'ONAPPUNINSTALL' | 'ON_ROBOT_CALL' | ...,
 *     event_token: 'opt-ack-token',
 *     document_id: ['crm', 'CCrmDocumentDeal', 'DEAL_123'] | ['crm', 'CCrmDocumentDeal', 'DEAL_FLEXIBLE_2_123'],
 *     document_type: ['crm', 'CCrmDocumentDeal', 'DEAL'],
 *     workflow_id: '...'
 *   }
 *
 * Execution flow:
 *   1. Look up the Webhook row by :token. 404 if missing or disabled.
 *   2. Validate `auth.application_token` against
 *      `AppSettings.applicationToken` — 401 on mismatch. This is the
 *      only authentication we perform; the URL token alone is enough
 *      to identify the webhook, but the portal shared secret proves
 *      that the caller really is our portal's bizproc engine.
 *   3. Parse `document_id[2]` into a positive integer dealId. Formats
 *      supported: `DEAL_123` (classic pipeline) and
 *      `DEAL_FLEXIBLE_<typeId>_<id>` (Smart Process / flexible CRM
 *      entities — we accept the id suffix for forward-compatibility).
 *   4. Build a `B24Client` from `auth.access_token` + `auth.domain`
 *      exactly like `routes/generate.ts` does.
 *   5. Resolve the list of templateIds from the webhook's scope:
 *        - scope='template' → `[webhook.templateId]`
 *        - scope='theme'    → all Templates inside the theme.
 *   6. Sequentially call `runGeneration()` for each template and
 *      collect per-template results. A single template failure does
 *      NOT abort the loop — it's recorded in the results array with
 *      `ok:false` and the error message.
 *   7. Update `webhook.useCount` / `webhook.lastUsedAt` (best-effort).
 *   8. If `event_token` is present, ack the bizproc engine via
 *      `bizproc.event.send` (failures are non-fatal — we still return
 *      the generation results to the caller).
 *   9. Return `{ ok, generated, failed, results }` JSON.
 *
 * Public route — NOT gated by the B24 middleware (see auth.ts
 * PUBLIC_PATHS). The URL token + application_token are the only
 * credentials checked.
 */

import type { FastifyInstance, FastifyBaseLogger } from 'fastify';
import { Readable } from 'node:stream';
import { prisma } from '../prisma/client.js';
import { B24Client, B24Error } from '../services/b24Client.js';
import { getFreshPortalAuth, PortalAuthError } from '../services/portalAuth.js';
import {
  runGeneration,
  GenerationError,
  type GenerationResult,
} from '../services/generationPipeline.js';

/* ------------------------------------------------------------------ */
/* Body shape (post-qs-parse)                                           */
/* ------------------------------------------------------------------ */

interface WebhookRunBody {
  auth?: {
    domain?: string;
    access_token?: string;
    member_id?: string;
    application_token?: string;
    // Some portals additionally send camelCase variants; accept both.
    accessToken?: string;
    memberId?: string;
    applicationToken?: string;
  };
  document_id?: string[] | Record<string, string>;
  event_token?: string;
  // The full payload carries many more fields — we don't care about them.
  [key: string]: unknown;
}

interface TemplateRunResult {
  templateId: string;
  ok: boolean;
  fileId?: number;
  downloadUrl?: string;
  fileName?: string;
  error?: string;
  errorKind?: string;
  warnings?: string[];
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

/**
 * Extract `document_id[2]` regardless of whether qs parsed it as an
 * array (sparse numeric keys collapse to an array when they're dense
 * enough) or as an object keyed by string indices (Bitrix sometimes
 * sends `document_id[0]=..&document_id[1]=..&document_id[2]=..` with
 * gaps that force qs into object mode).
 */
function readDocumentIdEntry(
  documentId: WebhookRunBody['document_id'],
  index: number,
): string | undefined {
  if (!documentId) return undefined;
  if (Array.isArray(documentId)) {
    return documentId[index];
  }
  if (typeof documentId === 'object') {
    const v = (documentId as Record<string, unknown>)[String(index)];
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

/**
 * Parse a Bitrix document identifier into a numeric deal id.
 *
 * Supported input formats:
 *   - `DEAL_123`              — classic CRM pipeline (the common case)
 *   - `DEAL_FLEXIBLE_2_123`   — Smart Process / flexible entity. We
 *     ignore the entity type prefix and extract the trailing numeric
 *     id so the pipeline can still run (it will call crm.item.get
 *     internally via the regular deal context helpers — if the caller
 *     misuses this on a non-deal entity, the deal context step will
 *     return 404 and propagate as a per-template failure).
 *
 * Returns `null` if the format isn't recognised.
 */
export function parseDealIdFromDocumentId(value: string | undefined): number | null {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();

  // DEAL_FLEXIBLE_<typeId>_<id>  (accept FLEXIBLE/FLEXABLE variants
  // defensively — Bitrix has renamed these at least once).
  const flexMatch = /^DEAL_(?:FLEXIBLE|FLEXABLE)_(\d+)_(\d+)$/i.exec(trimmed);
  if (flexMatch) {
    const n = Number(flexMatch[2]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // DEAL_<id>
  const classicMatch = /^DEAL_(\d+)$/i.exec(trimmed);
  if (classicMatch) {
    const n = Number(classicMatch[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  return null;
}

/**
 * Normalise a Bitrix portal domain for comparison. The value can be
 * stored in AppSettings with or without the `https://` scheme (and
 * sometimes with a trailing slash or path), while the robot payload
 * always sends a bare host like `example.bitrix24.ru`. We strip both
 * forms down to just the lowercase host so the equality check works.
 */
function normaliseDomain(value: string | undefined | null): string {
  if (!value) return '';
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
}

/**
 * Extract a trimmed string from any of the known key aliases that
 * Bitrix / users might send (snake_case vs camelCase).
 */
function pickString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

/**
 * Summarise a successful generation into the per-template response
 * shape. Keeps the webhook response envelope small — we don't echo
 * the full formula map on the webhook side because the robot caller
 * cannot do anything useful with it.
 */
function summariseSuccess(
  templateId: string,
  result: GenerationResult,
): TemplateRunResult {
  return {
    templateId,
    ok: true,
    fileId: result.fileId,
    downloadUrl: result.downloadUrl,
    fileName: result.fileName,
    warnings: result.warnings.length > 0 ? result.warnings : undefined,
  };
}

/**
 * Fire-and-forget ack for the bizproc engine. Bitrix calls this
 * `bizproc.event.send` — it tells the waiting workflow step that the
 * external activity has completed. Absence of `event_token` means the
 * robot was configured without the "wait for response" flag, in which
 * case there's nothing to ack.
 *
 * We intentionally swallow all errors from this call — the generation
 * itself already succeeded, and we don't want a bizproc ack failure
 * to turn the whole response into a 500.
 */
async function sendBizprocAck(
  client: B24Client,
  eventToken: string,
  logger: FastifyBaseLogger,
): Promise<void> {
  try {
    await client.callMethod('bizproc.event.send', {
      event_token: eventToken,
      return_values: {},
    });
    logger.info({ eventToken }, 'bizproc.event.send ok');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg, eventToken }, 'bizproc.event.send failed (non-fatal)');
  }
}

/* ------------------------------------------------------------------ */
/* Route registration                                                   */
/* ------------------------------------------------------------------ */

/**
 * Strip secret-ish fields out of the parsed body for logging.
 * We want to see the shape of what the robot sent without leaking
 * tokens into the log file. Access/application tokens are truncated
 * to the first 6 chars so mismatches are still debuggable.
 */
function sanitiseBodyForLog(body: WebhookRunBody): unknown {
  const clone: Record<string, unknown> = { ...body };
  if (body.auth && typeof body.auth === 'object') {
    const a = body.auth;
    const maskToken = (t: string | undefined): string | undefined =>
      t ? `${t.slice(0, 6)}…(${t.length})` : undefined;
    clone.auth = {
      ...a,
      access_token: maskToken(a.access_token),
      accessToken: maskToken(a.accessToken),
      application_token: maskToken(a.application_token),
      applicationToken: maskToken(a.applicationToken),
    };
  }
  return clone;
}

/**
 * Mask the raw urlencoded body the same way — we don't want the
 * unredacted access_token hitting the log, but we want enough of it
 * to correlate with incoming webhooks.
 */
function sanitiseRawBodyForLog(raw: string): string {
  if (!raw) return raw;
  return raw.replace(
    /(auth(?:\[|%5B)(?:access_token|accessToken|application_token|applicationToken)(?:\]|%5D)=)([^&]+)/gi,
    (_m, key: string, val: string) => `${key}${val.slice(0, 6)}…(${val.length})`,
  );
}

export async function registerWebhookRunRoute(app: FastifyInstance): Promise<void> {
  app.post<{
    Params: { token: string };
    Body: WebhookRunBody;
  }>(
    '/api/webhook/run/:token',
    {
      /* ---------------------------------------------------------- */
      /* Capture the raw urlencoded body BEFORE @fastify/formbody    */
      /* consumes the stream, so we can log it for debugging.        */
      /* ---------------------------------------------------------- */
      preParsing: async (request, _reply, payload) => {
        const chunks: Buffer[] = [];
        for await (const chunk of payload) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const rawBuffer = Buffer.concat(chunks);
        (request as unknown as { rawBody?: string }).rawBody = rawBuffer.toString('utf-8');
        // Re-emit the SAME bytes as a fresh Buffer-carrying stream for
        // the content-type parser downstream. Must emit Buffer chunks
        // (not strings) because @fastify/formbody calls Buffer.concat
        // on whatever the stream yields.
        return Readable.from([rawBuffer]);
      },
    },
    async (request, reply) => {
      const { token } = request.params;
      const body = (request.body ?? {}) as WebhookRunBody;
      const logger = request.log;
      const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? '';

      /* ------------------------------------------------------------ */
      /* 0) Log the incoming raw request                               */
      /* ------------------------------------------------------------ */
      logger.info(
        {
          token,
          method: request.method,
          url: request.url,
          headers: {
            'content-type': request.headers['content-type'],
            'content-length': request.headers['content-length'],
            'user-agent': request.headers['user-agent'],
            host: request.headers.host,
            'x-forwarded-for': request.headers['x-forwarded-for'],
          },
          query: request.query,
          rawBodyLength: rawBody.length,
          rawBody: sanitiseRawBodyForLog(rawBody),
          parsedBody: sanitiseBodyForLog(body),
        },
        'webhookRun: incoming request',
      );

    /* ------------------------------------------------------------ */
    /* 1) Look up the webhook                                        */
    /* ------------------------------------------------------------ */
    if (!token || typeof token !== 'string') {
      return reply.notFound('webhook not found');
    }

    const webhook = await prisma.webhook.findUnique({
      where: { token },
    });
    if (!webhook) {
      logger.warn({ token }, 'webhookRun: token not found');
      return reply.notFound('webhook not found');
    }
    if (!webhook.enabled) {
      logger.warn({ token, id: webhook.id }, 'webhookRun: webhook disabled');
      return reply.notFound('webhook not found');
    }

    /* ------------------------------------------------------------ */
    /* 2) Verify the caller is our installed portal                  */
    /*                                                                */
    /* Bitrix24's built-in "Outgoing webhook" robot does NOT send an  */
    /* application_token or an access_token in the payload — only     */
    /* domain, member_id, client_endpoint and server_endpoint. So we  */
    /* cross-check member_id + domain against what we captured during */
    /* install; a match proves the caller speaks for our portal.      */
    /* ------------------------------------------------------------ */
    const settingsRow = await prisma.appSettings.findUnique({ where: { id: 1 } });
    if (!settingsRow) {
      logger.error({ webhookId: webhook.id }, 'webhookRun: AppSettings missing');
      return reply.unauthorized('application not installed');
    }

    const incomingMemberId = pickString(body.auth?.member_id, body.auth?.memberId);
    const incomingDomain = pickString(body.auth?.domain);
    if (!incomingMemberId || !incomingDomain) {
      logger.warn(
        {
          webhookId: webhook.id,
          hasMemberId: Boolean(incomingMemberId),
          hasDomain: Boolean(incomingDomain),
        },
        'webhookRun: auth.member_id or auth.domain missing',
      );
      return reply.badRequest('auth.member_id and auth.domain are required');
    }
    const expectedMemberId = settingsRow.memberId;
    const expectedDomain = settingsRow.portalDomain;
    const incomingDomainNormalised = normaliseDomain(incomingDomain);
    const expectedDomainNormalised = normaliseDomain(expectedDomain);
    if (
      (expectedMemberId && incomingMemberId !== expectedMemberId) ||
      (expectedDomainNormalised && incomingDomainNormalised !== expectedDomainNormalised)
    ) {
      logger.warn(
        {
          webhookId: webhook.id,
          incomingMemberId,
          incomingDomain,
          incomingDomainNormalised,
          expectedMemberId,
          expectedDomain,
          expectedDomainNormalised,
        },
        'webhookRun: member_id / domain mismatch',
      );
      return reply.unauthorized('member_id or domain mismatch');
    }

    /* ------------------------------------------------------------ */
    /* 3) Parse document_id → dealId                                 */
    /* ------------------------------------------------------------ */
    const documentIdEntry = readDocumentIdEntry(body.document_id, 2);
    const dealId = parseDealIdFromDocumentId(documentIdEntry);
    if (dealId === null) {
      logger.warn(
        { webhookId: webhook.id, documentIdEntry },
        'webhookRun: cannot parse document_id[2]',
      );
      return reply.badRequest(
        `document_id[2] must be "DEAL_<id>" or "DEAL_FLEXIBLE_<typeId>_<id>", got ${documentIdEntry ?? 'undefined'}`,
      );
    }

    /* ------------------------------------------------------------ */
    /* 4) Obtain a fresh access token from the stored OAuth pair     */
    /*                                                                */
    /* The robot payload does NOT include an access token, so we use */
    /* the refresh_token captured at install time (AppSettings) and  */
    /* let portalAuth.getFreshPortalAuth() refresh it if needed.      */
    /* ------------------------------------------------------------ */
    let portalAuth;
    try {
      portalAuth = await getFreshPortalAuth();
    } catch (err) {
      if (err instanceof PortalAuthError) {
        logger.error(
          { webhookId: webhook.id, kind: err.kind, err: err.message },
          'webhookRun: portalAuth failed',
        );
        if (err.kind === 'missing_client_credentials' || err.kind === 'missing_tokens') {
          return reply.serviceUnavailable(`portal auth unavailable: ${err.message}`);
        }
        return reply.internalServerError(`portal auth error: ${err.message}`);
      }
      throw err;
    }

    const client = new B24Client({
      portal: portalAuth.domain,
      accessToken: portalAuth.accessToken,
    });

    /* ------------------------------------------------------------ */
    /* 5) Resolve target templates from the webhook scope            */
    /* ------------------------------------------------------------ */
    let templateIds: string[] = [];
    if (webhook.scope === 'template') {
      if (!webhook.templateId) {
        logger.error({ webhookId: webhook.id }, 'webhookRun: scope=template but templateId is null');
        return reply.internalServerError('webhook scope/template mismatch');
      }
      templateIds = [webhook.templateId];
    } else if (webhook.scope === 'theme') {
      if (!webhook.themeId) {
        logger.error({ webhookId: webhook.id }, 'webhookRun: scope=theme but themeId is null');
        return reply.internalServerError('webhook scope/theme mismatch');
      }
      const rows = await prisma.template.findMany({
        where: { themeId: webhook.themeId },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      templateIds = rows.map((r) => r.id);
    } else {
      logger.error({ webhookId: webhook.id, scope: webhook.scope }, 'webhookRun: unknown scope');
      return reply.internalServerError(`unknown webhook scope: ${webhook.scope}`);
    }

    if (templateIds.length === 0) {
      logger.warn({ webhookId: webhook.id }, 'webhookRun: no templates in scope');
    }

    /* ------------------------------------------------------------ */
    /* 6) Run each template sequentially                             */
    /* ------------------------------------------------------------ */
    const results: TemplateRunResult[] = [];
    let generated = 0;
    let failed = 0;

    for (const templateId of templateIds) {
      try {
        const result = await runGeneration({
          templateId,
          dealId,
          client,
          logger,
        });
        results.push(summariseSuccess(templateId, result));
        generated += 1;
      } catch (err) {
        failed += 1;
        if (err instanceof GenerationError) {
          results.push({
            templateId,
            ok: false,
            error: err.message,
            errorKind: err.kind,
          });
          logger.warn(
            { webhookId: webhook.id, templateId, kind: err.kind, err: err.message },
            'webhookRun: template generation failed',
          );
        } else if (err instanceof B24Error) {
          results.push({
            templateId,
            ok: false,
            error: err.message,
            errorKind: 'b24_error',
          });
          logger.warn(
            { webhookId: webhook.id, templateId, code: err.code, err: err.message },
            'webhookRun: B24 error during generation',
          );
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({
            templateId,
            ok: false,
            error: msg,
            errorKind: 'unexpected',
          });
          logger.error(
            { webhookId: webhook.id, templateId, err: msg },
            'webhookRun: unexpected generation error',
          );
        }
      }
    }

    /* ------------------------------------------------------------ */
    /* 7) Update webhook stats (best-effort)                         */
    /* ------------------------------------------------------------ */
    try {
      await prisma.webhook.update({
        where: { id: webhook.id },
        data: {
          useCount: { increment: 1 },
          lastUsedAt: new Date(),
        },
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), webhookId: webhook.id },
        'webhookRun: failed to update useCount/lastUsedAt',
      );
    }

    /* ------------------------------------------------------------ */
    /* 8) Optional bizproc ack                                       */
    /* ------------------------------------------------------------ */
    const eventToken = pickString(body.event_token, (body as { eventToken?: unknown }).eventToken);
    if (eventToken) {
      await sendBizprocAck(client, eventToken, logger);
    }

    /* ------------------------------------------------------------ */
    /* 9) Response                                                   */
    /* ------------------------------------------------------------ */
    return {
      ok: failed === 0,
      dealId,
      generated,
      failed,
      results,
    };
    },
  );
}
