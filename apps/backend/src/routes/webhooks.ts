/**
 * Webhook routes — admin-only CRUD for outbound webhook triggers that
 * allow Bitrix24's "Outgoing webhook" robot to kick off the document
 * generation pipeline without a human clicking a button.
 *
 *  - `GET    /api/webhooks`       — list all configured webhooks.
 *      Joined with Theme/Template so the frontend can render a
 *      human-readable target name.
 *  - `POST   /api/webhooks`       — create a new webhook. Body:
 *      `{ scope, themeId?, templateId?, label? }`. The handler
 *      generates a cryptographically random 24-byte token encoded as
 *      base64url and validates that the referenced Theme/Template row
 *      actually exists.
 *  - `PATCH  /api/webhooks/:id`   — update only `label` and `enabled`.
 *      Other fields (scope, token, themeId, templateId) are immutable.
 *  - `DELETE /api/webhooks/:id`   — remove a webhook. Returns 204.
 *
 * All routes are gated by `requireAdmin` (see `middleware/role.ts`) —
 * there is no read path for non-admin users because the token embedded
 * in the URL is effectively an auth credential.
 *
 * The DTO returned is `WebhookSummary` from `@b24-doc-gen/shared`. The
 * `url` field is built as `${PUBLIC_URL}/api/webhook/run/${token}` and
 * is what the admin copies into the Bitrix24 robot configuration.
 */

import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { WebhookSummary } from '@b24-doc-gen/shared';
import { prisma } from '../prisma/client.js';
import { requireAdmin } from '../middleware/role.js';

/* ------------------------------------------------------------------ */
/* Request/response shapes                                              */
/* ------------------------------------------------------------------ */

interface CreateWebhookBody {
  scope?: unknown;
  themeId?: unknown;
  templateId?: unknown;
  label?: unknown;
}

interface UpdateWebhookBody {
  label?: unknown;
  enabled?: unknown;
}

interface WebhookIdParam {
  id: string;
}

/** Prisma row shape we rely on for DTO mapping. */
interface WebhookRow {
  id: string;
  token: string;
  scope: string;
  themeId: string | null;
  templateId: string | null;
  label: string | null;
  enabled: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
  useCount: number;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

/**
 * Resolve the public base URL used in generated webhook URLs. We mirror
 * the precedence used by `routes/install.ts` so the admin only has to
 * configure PUBLIC_URL (or FRONTEND_PUBLIC_URL) in one place.
 */
function resolvePublicBaseUrl(): string {
  const raw =
    process.env.PUBLIC_URL ??
    process.env.FRONTEND_PUBLIC_URL ??
    process.env.FRONTEND_URL ??
    '';
  return raw.replace(/\/+$/, '');
}

function buildWebhookUrl(token: string): string {
  const base = resolvePublicBaseUrl();
  // If no PUBLIC_URL is configured we still return a well-formed path
  // so the frontend can display SOMETHING. The admin will see a
  // relative URL and know they need to set PUBLIC_URL.
  return `${base}/api/webhook/run/${token}`;
}

function toWebhookSummary(row: WebhookRow): WebhookSummary {
  return {
    id: row.id,
    token: row.token,
    url: buildWebhookUrl(row.token),
    scope: row.scope === 'template' ? 'template' : 'theme',
    themeId: row.themeId,
    templateId: row.templateId,
    label: row.label,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    useCount: row.useCount,
  };
}

function normalizeLabel(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 200) return undefined;
  return trimmed;
}

function normalizeScope(value: unknown): 'theme' | 'template' | null {
  if (value === 'theme' || value === 'template') return value;
  return null;
}

function generateToken(): string {
  // 24 raw bytes → 32 base64url characters, URL-safe, no padding.
  return randomBytes(24).toString('base64url');
}

/* ------------------------------------------------------------------ */
/* Route registration                                                   */
/* ------------------------------------------------------------------ */

export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------------------------------------------------------- */
  /* GET /api/webhooks                                                 */
  /* ---------------------------------------------------------------- */
  app.get('/api/webhooks', { preHandler: requireAdmin }, async (request, reply) => {
    const auth = request.b24Auth;
    if (!auth) return reply.unauthorized('B24 auth payload missing');

    // Join Theme and Template so the frontend can render a friendly
    // target name without a second round-trip. We only select `name`
    // to keep the payload small.
    const rows = await prisma.webhook.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        theme: { select: { id: true, name: true } },
        template: { select: { id: true, name: true } },
      },
    });

    const webhooks = rows.map((row) => {
      const summary = toWebhookSummary(row);
      // Attach the joined name under a nullable field so the shared
      // DTO stays lean but the frontend can still render it.
      return {
        ...summary,
        themeName: row.theme?.name ?? null,
        templateName: row.template?.name ?? null,
      };
    });

    return { webhooks };
  });

  /* ---------------------------------------------------------------- */
  /* POST /api/webhooks                                                */
  /* ---------------------------------------------------------------- */
  app.post<{ Body: CreateWebhookBody }>(
    '/api/webhooks',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const auth = request.b24Auth;
      if (!auth) return reply.unauthorized('B24 auth payload missing');

      const body = request.body ?? ({} as CreateWebhookBody);
      const scope = normalizeScope(body.scope);
      if (!scope) {
        return reply.badRequest('scope must be "theme" or "template"');
      }

      const label = normalizeLabel(body.label);
      // normalizeLabel returns undefined only if the caller sent an
      // unsupported type or an over-long string — reject those.
      if (label === undefined && body.label !== undefined) {
        return reply.badRequest('label must be a string up to 200 characters or null');
      }

      let themeId: string | null = null;
      let templateId: string | null = null;

      if (scope === 'theme') {
        if (typeof body.themeId !== 'string' || body.themeId.trim().length === 0) {
          return reply.badRequest('themeId is required when scope is "theme"');
        }
        themeId = body.themeId.trim();
        const theme = await prisma.theme.findUnique({
          where: { id: themeId },
          select: { id: true },
        });
        if (!theme) {
          return reply.notFound(`theme ${themeId} not found`);
        }
      } else {
        if (typeof body.templateId !== 'string' || body.templateId.trim().length === 0) {
          return reply.badRequest('templateId is required when scope is "template"');
        }
        templateId = body.templateId.trim();
        const template = await prisma.template.findUnique({
          where: { id: templateId },
          select: { id: true },
        });
        if (!template) {
          return reply.notFound(`template ${templateId} not found`);
        }
      }

      // Retry token generation up to 3 times in the unlikely event of
      // a collision on the UNIQUE index. 24 bytes of entropy makes a
      // collision astronomically improbable, so this is belt-and-braces.
      let created: WebhookRow | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const token = generateToken();
        try {
          created = await prisma.webhook.create({
            data: {
              token,
              scope,
              themeId,
              templateId,
              label: label ?? null,
              enabled: true,
            },
          });
          break;
        } catch (err) {
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === 'P2002'
          ) {
            // Unique constraint collision on token — try again.
            continue;
          }
          throw err;
        }
      }

      if (!created) {
        return reply.internalServerError('failed to allocate unique webhook token');
      }

      return reply.code(201).send({ webhook: toWebhookSummary(created) });
    },
  );

  /* ---------------------------------------------------------------- */
  /* PATCH /api/webhooks/:id                                           */
  /* ---------------------------------------------------------------- */
  app.patch<{ Params: WebhookIdParam; Body: UpdateWebhookBody }>(
    '/api/webhooks/:id',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const auth = request.b24Auth;
      if (!auth) return reply.unauthorized('B24 auth payload missing');

      const { id } = request.params;
      if (!id) return reply.badRequest('id is required');

      const body = request.body ?? ({} as UpdateWebhookBody);
      const data: Prisma.WebhookUpdateInput = {};

      if (body.label !== undefined) {
        const label = normalizeLabel(body.label);
        if (label === undefined) {
          return reply.badRequest('label must be a string up to 200 characters or null');
        }
        data.label = label;
      }

      if (body.enabled !== undefined) {
        if (typeof body.enabled !== 'boolean') {
          return reply.badRequest('enabled must be boolean');
        }
        data.enabled = body.enabled;
      }

      if (Object.keys(data).length === 0) {
        return reply.badRequest('nothing to update (only label and enabled are mutable)');
      }

      try {
        const row = await prisma.webhook.update({
          where: { id },
          data,
        });
        return { webhook: toWebhookSummary(row) };
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2025'
        ) {
          return reply.notFound(`webhook ${id} not found`);
        }
        throw err;
      }
    },
  );

  /* ---------------------------------------------------------------- */
  /* DELETE /api/webhooks/:id                                          */
  /* ---------------------------------------------------------------- */
  app.delete<{ Params: WebhookIdParam }>(
    '/api/webhooks/:id',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const auth = request.b24Auth;
      if (!auth) return reply.unauthorized('B24 auth payload missing');

      const { id } = request.params;
      if (!id) return reply.badRequest('id is required');

      try {
        await prisma.webhook.delete({ where: { id } });
        return reply.code(204).send();
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2025'
        ) {
          return reply.notFound(`webhook ${id} not found`);
        }
        throw err;
      }
    },
  );
}
