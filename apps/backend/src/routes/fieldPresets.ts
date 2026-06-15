/**
 * Field-preset routes — CRUD for reusable `select` field presets.
 *
 * A preset is a named, admin-defined dropdown (its options + value
 * mapping) that can be reused across templates. Instead of re-entering
 * the same option list every time a `select` manual field is bound to a
 * tag, an admin defines the list once here (in Settings) and picks it in
 * the ManualFieldBuilder.
 *
 *  - `GET    /api/field-presets`     — list all presets (order ASC, name).
 *  - `POST   /api/field-presets`     — create a preset (admin).
 *  - `PUT    /api/field-presets/:id` — update name/valueMode/options/order (admin).
 *  - `DELETE /api/field-presets/:id` — delete a preset (admin).
 *
 * Read is gated by the global B24 auth middleware; mutations also require
 * the admin role (`requireAdmin`). `options` is stored as a JSON string
 * in SQLite and (de)serialized at the route boundary.
 */

import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import type { FieldPreset, SelectOption, SelectValueMode } from '@b24-doc-gen/shared';
import { prisma } from '../prisma/client.js';
import { requireAdmin } from '../middleware/role.js';

/* ------------------------------------------------------------------ */
/* DTOs                                                                */
/* ------------------------------------------------------------------ */

interface CreatePresetBody {
  name: string;
  valueMode?: SelectValueMode;
  options?: SelectOption[];
  order?: number;
}

interface UpdatePresetBody {
  name?: string;
  valueMode?: SelectValueMode;
  options?: SelectOption[];
  order?: number;
}

interface PresetIdParam {
  id: string;
}

interface FieldPresetRow {
  id: string;
  name: string;
  valueMode: string;
  options: string;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

/* ------------------------------------------------------------------ */
/* Normalization helpers                                               */
/* ------------------------------------------------------------------ */

function normalizeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  return trimmed;
}

function normalizeValueMode(value: unknown): SelectValueMode {
  return value === 'mapped' ? 'mapped' : 'direct';
}

function normalizeOrder(value: unknown, fallback = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

/**
 * Coerce an arbitrary `options` payload into a clean `SelectOption[]`:
 * keep only entries with a non-empty string label, trim both fields.
 */
function normalizeOptions(value: unknown): SelectOption[] {
  if (!Array.isArray(value)) return [];
  const out: SelectOption[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const label = String((item as { label?: unknown }).label ?? '').trim();
    const val = String((item as { value?: unknown }).value ?? '').trim();
    if (label.length === 0) continue;
    out.push({ label, value: val });
  }
  return out;
}

/** Parse the JSON `options` column, tolerating corrupt data. */
function parseOptions(raw: string): SelectOption[] {
  try {
    return normalizeOptions(JSON.parse(raw));
  } catch {
    return [];
  }
}

function toPresetDto(row: FieldPresetRow): FieldPreset {
  return {
    id: row.id,
    name: row.name,
    valueMode: normalizeValueMode(row.valueMode),
    options: parseOptions(row.options),
    order: row.order,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Internal helpers exposed for unit tests (see `fieldPresets.test.ts`).
 * Not part of the public route surface.
 */
export const __test = {
  normalizeName,
  normalizeValueMode,
  normalizeOrder,
  normalizeOptions,
  parseOptions,
  toPresetDto,
};

/* ------------------------------------------------------------------ */
/* Route registration                                                  */
/* ------------------------------------------------------------------ */

export async function registerFieldPresetRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------------------------------------------------------- */
  /* GET /api/field-presets                                           */
  /* ---------------------------------------------------------------- */
  app.get('/api/field-presets', async (request, reply) => {
    const auth = request.b24Auth;
    if (!auth) return reply.unauthorized('B24 auth payload missing');

    const rows = await prisma.fieldPreset.findMany({
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
    });
    return { presets: rows.map(toPresetDto) };
  });

  /* ---------------------------------------------------------------- */
  /* POST /api/field-presets                                          */
  /* ---------------------------------------------------------------- */
  app.post<{ Body: CreatePresetBody }>(
    '/api/field-presets',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const auth = request.b24Auth;
      if (!auth) return reply.unauthorized('B24 auth payload missing');

      const body = request.body ?? ({} as CreatePresetBody);
      const name = normalizeName(body.name);
      if (!name) {
        return reply.badRequest('name is required and must be 1..200 chars');
      }
      const options = normalizeOptions(body.options);
      if (options.length === 0) {
        return reply.badRequest('at least one option is required');
      }

      // Default order = max(order) + 1 so new presets land at the end.
      let order: number;
      if (body.order !== undefined) {
        order = normalizeOrder(body.order, 0);
      } else {
        const last = await prisma.fieldPreset.findFirst({
          orderBy: { order: 'desc' },
          select: { order: true },
        });
        order = last ? last.order + 1 : 0;
      }

      const row = await prisma.fieldPreset.create({
        data: {
          name,
          valueMode: normalizeValueMode(body.valueMode),
          options: JSON.stringify(options),
          order,
        },
      });
      return reply.code(201).send({ preset: toPresetDto(row) });
    },
  );

  /* ---------------------------------------------------------------- */
  /* PUT /api/field-presets/:id                                       */
  /* ---------------------------------------------------------------- */
  app.put<{ Params: PresetIdParam; Body: UpdatePresetBody }>(
    '/api/field-presets/:id',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const auth = request.b24Auth;
      if (!auth) return reply.unauthorized('B24 auth payload missing');

      const { id } = request.params;
      if (!id) return reply.badRequest('id is required');

      const body = request.body ?? ({} as UpdatePresetBody);
      const data: Prisma.FieldPresetUpdateInput = {};

      if (body.name !== undefined) {
        const name = normalizeName(body.name);
        if (!name) return reply.badRequest('name must be 1..200 chars');
        data.name = name;
      }
      if (body.valueMode !== undefined) {
        data.valueMode = normalizeValueMode(body.valueMode);
      }
      if (body.options !== undefined) {
        const options = normalizeOptions(body.options);
        if (options.length === 0) {
          return reply.badRequest('at least one option is required');
        }
        data.options = JSON.stringify(options);
      }
      if (body.order !== undefined) {
        data.order = normalizeOrder(body.order, 0);
      }

      if (Object.keys(data).length === 0) {
        return reply.badRequest('nothing to update');
      }

      try {
        const row = await prisma.fieldPreset.update({ where: { id }, data });
        return { preset: toPresetDto(row) };
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2025'
        ) {
          return reply.notFound(`field preset ${id} not found`);
        }
        throw err;
      }
    },
  );

  /* ---------------------------------------------------------------- */
  /* DELETE /api/field-presets/:id                                    */
  /* ---------------------------------------------------------------- */
  app.delete<{ Params: PresetIdParam }>(
    '/api/field-presets/:id',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const auth = request.b24Auth;
      if (!auth) return reply.unauthorized('B24 auth payload missing');

      const { id } = request.params;
      if (!id) return reply.badRequest('id is required');

      try {
        await prisma.fieldPreset.delete({ where: { id } });
        return reply.code(204).send();
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2025'
        ) {
          return reply.notFound(`field preset ${id} not found`);
        }
        throw err;
      }
    },
  );
}
