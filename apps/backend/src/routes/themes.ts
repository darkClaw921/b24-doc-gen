/**
 * Theme routes — CRUD for template themes (groups of templates).
 *
 *  - `GET    /api/themes`       — list all themes (sorted by `order` ASC, then `name`).
 *  - `POST   /api/themes`       — create a new theme.
 *  - `PUT    /api/themes/:id`   — update name and/or order.
 *  - `DELETE /api/themes/:id`   — delete a theme. Returns 409 if it
 *                                  still has templates attached so the
 *                                  frontend can show a friendly error.
 *
 * Mutation routes (POST/PUT/DELETE) currently rely on the global
 * `auth` middleware to populate `request.b24Auth`. They do NOT yet
 * enforce the admin role — that check is added in Phase 6 (bz3.1).
 * The handlers already read `request.b24Auth.userId` so the admin
 * gate can be slotted in without a signature change.
 */

import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma/client.js';
import { requireAdmin } from '../middleware/role.js';

interface CreateThemeBody {
  name: string;
  order?: number;
  addToTimeline?: boolean;
  dealFieldBinding?: string | null;
}

interface UpdateThemeBody {
  name?: string;
  order?: number;
  addToTimeline?: boolean;
  dealFieldBinding?: string | null;
}

interface ThemeIdParam {
  id: string;
}

/**
 * Public DTO returned by the theme endpoints. Mirrors the Prisma row
 * but converts dates to ISO strings so the frontend can consume it
 * without a date parser.
 */
export interface ThemeDTO {
  id: string;
  name: string;
  order: number;
  addToTimeline: boolean;
  dealFieldBinding: string | null;
  templatesCount?: number;
  createdAt: string;
  updatedAt: string;
}

function normalizeFieldBinding(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normalizeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  return trimmed;
}

function normalizeOrder(value: unknown, fallback = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

interface ThemeRowWithCount {
  id: string;
  name: string;
  order: number;
  addToTimeline: boolean;
  dealFieldBinding: string | null;
  createdAt: Date;
  updatedAt: Date;
  _count?: { templates: number };
}

function toThemeDto(row: ThemeRowWithCount): ThemeDTO {
  return {
    id: row.id,
    name: row.name,
    order: row.order,
    addToTimeline: row.addToTimeline,
    dealFieldBinding: row.dealFieldBinding,
    templatesCount: row._count?.templates,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function registerThemeRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------------------------------------------------------- */
  /* GET /api/themes                                                   */
  /* ---------------------------------------------------------------- */
  app.get('/api/themes', async (request, reply) => {
    const auth = request.b24Auth;
    if (!auth) return reply.unauthorized('B24 auth payload missing');

    const rows = await prisma.theme.findMany({
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
      include: {
        _count: { select: { templates: true } },
      },
    });

    return { themes: rows.map(toThemeDto) };
  });

  /* ---------------------------------------------------------------- */
  /* POST /api/themes                                                  */
  /* ---------------------------------------------------------------- */
  app.post<{ Body: CreateThemeBody }>('/api/themes', { preHandler: requireAdmin }, async (request, reply) => {
    const auth = request.b24Auth;
    if (!auth) return reply.unauthorized('B24 auth payload missing');

    const body = request.body ?? ({} as CreateThemeBody);
    const name = normalizeName(body.name);
    if (!name) {
      return reply.badRequest('name is required and must be 1..200 chars');
    }

    // Default order = max(order) + 1 so new themes appear at the end.
    let order: number;
    if (body.order !== undefined) {
      order = normalizeOrder(body.order, 0);
    } else {
      const last = await prisma.theme.findFirst({
        orderBy: { order: 'desc' },
        select: { order: true },
      });
      order = last ? last.order + 1 : 0;
    }

    const addToTimeline =
      typeof body.addToTimeline === 'boolean' ? body.addToTimeline : true;
    const dealFieldBindingRaw = normalizeFieldBinding(body.dealFieldBinding);
    const dealFieldBinding =
      dealFieldBindingRaw === undefined ? null : dealFieldBindingRaw;

    const row = await prisma.theme.create({
      data: { name, order, addToTimeline, dealFieldBinding },
      include: { _count: { select: { templates: true } } },
    });

    return reply.code(201).send({ theme: toThemeDto(row) });
  });

  /* ---------------------------------------------------------------- */
  /* PUT /api/themes/:id                                               */
  /* ---------------------------------------------------------------- */
  app.put<{ Params: ThemeIdParam; Body: UpdateThemeBody }>(
    '/api/themes/:id',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const auth = request.b24Auth;
      if (!auth) return reply.unauthorized('B24 auth payload missing');

      const { id } = request.params;
      if (!id) return reply.badRequest('id is required');

      const body = request.body ?? ({} as UpdateThemeBody);
      const data: Prisma.ThemeUpdateInput = {};

      if (body.name !== undefined) {
        const name = normalizeName(body.name);
        if (!name) return reply.badRequest('name must be 1..200 chars');
        data.name = name;
      }
      if (body.order !== undefined) {
        data.order = normalizeOrder(body.order, 0);
      }
      if (body.addToTimeline !== undefined) {
        if (typeof body.addToTimeline !== 'boolean') {
          return reply.badRequest('addToTimeline must be boolean');
        }
        data.addToTimeline = body.addToTimeline;
      }
      if (body.dealFieldBinding !== undefined) {
        const normalized = normalizeFieldBinding(body.dealFieldBinding);
        // normalizeFieldBinding only returns undefined for non-string,
        // non-null values — reject those.
        if (normalized === undefined) {
          return reply.badRequest('dealFieldBinding must be string or null');
        }
        data.dealFieldBinding = normalized;
      }

      if (Object.keys(data).length === 0) {
        return reply.badRequest('nothing to update');
      }

      try {
        const row = await prisma.theme.update({
          where: { id },
          data,
          include: { _count: { select: { templates: true } } },
        });
        return { theme: toThemeDto(row) };
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2025'
        ) {
          return reply.notFound(`theme ${id} not found`);
        }
        throw err;
      }
    },
  );

  /* ---------------------------------------------------------------- */
  /* DELETE /api/themes/:id                                            */
  /* ---------------------------------------------------------------- */
  app.delete<{ Params: ThemeIdParam }>('/api/themes/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const auth = request.b24Auth;
    if (!auth) return reply.unauthorized('B24 auth payload missing');

    const { id } = request.params;
    if (!id) return reply.badRequest('id is required');

    // Refuse to delete a theme that still owns templates — surfaces a
    // friendly 409 instead of a foreign-key 500.
    const templatesCount = await prisma.template.count({ where: { themeId: id } });
    if (templatesCount > 0) {
      return reply.conflict(
        `Тему нельзя удалить: к ней привязано ${templatesCount} шаблон(ов). Сначала удалите или перенесите шаблоны.`,
      );
    }

    try {
      await prisma.theme.delete({ where: { id } });
      return reply.code(204).send();
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        return reply.notFound(`theme ${id} not found`);
      }
      throw err;
    }
  });
}
