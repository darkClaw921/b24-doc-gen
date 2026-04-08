/**
 * Settings routes — manage the persistent `AppSettings` singleton and
 * the Bitrix24 side of deal-field bindings.
 *
 *  - `GET    /api/settings`                — read-only view of the
 *      current AppSettings row, including the list of admin user IDs
 *      (so the SettingsPage can render the admin picker).
 *  - `PUT    /api/settings`                — update mutable settings.
 *      The request body is `{ dealFieldBinding?, adminUserIds? }`.
 *      Each field is optional: omit a key to leave it unchanged.
 *  - `GET    /api/settings/deal-fields`    — return every `UF_CRM_*`
 *      user-defined deal field with `type = 'file'`. Used by the
 *      SettingsPage dropdown where admins pick the slot into which
 *      generated documents are uploaded.
 *  - `POST   /api/settings/create-field`   — create a new file-typed
 *      UF_CRM field via `crm.deal.userfield.add`. Body:
 *      `{ xmlId, label }`. On success returns the newly-created field
 *      id and, when the follow-up `crm.deal.userfield.list` locates
 *      the record, the canonical FIELD_NAME (`UF_CRM_*`).
 *
 * All routes are gated by the global B24 auth middleware; admin-role
 * enforcement is added in Phase 6 (bz3.1). They intentionally return
 * structured errors instead of relying on reply.internalServerError
 * so the frontend can surface the `B24Error.message` inline.
 */

import type { FastifyInstance } from 'fastify';
import type { AppSettings as PrismaAppSettings } from '@prisma/client';
import type { AppSettings } from '@b24-doc-gen/shared';
import { prisma } from '../prisma/client.js';
import { B24Client, B24Error } from '../services/b24Client.js';
import { toAppSettings } from './install.js';
import { requireAdmin, invalidateRoleCache } from '../middleware/role.js';

/* ------------------------------------------------------------------ */
/* DTOs                                                                */
/* ------------------------------------------------------------------ */

interface PutSettingsBody {
  dealFieldBinding?: string | null;
  adminUserIds?: number[];
}

interface CreateFieldBody {
  xmlId: string;
  label: string;
  /** When true, creates the field as multi-value (MULTIPLE='Y'). */
  multiple?: boolean;
}

/** Simplified UF field metadata returned to the SettingsPage. */
export interface DealFileFieldDTO {
  id: number;
  fieldName: string;
  xmlId: string | null;
  editFormLabel: string | null;
  listLabel: string | null;
  multiple: boolean;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function loadSettings(): Promise<PrismaAppSettings | null> {
  return prisma.appSettings.findUnique({ where: { id: 1 } });
}

/**
 * Ensure the AppSettings row exists. Unlike `POST /api/install`,
 * this does not require a non-empty admin list — the install flow
 * should run first. If the row is missing we throw so routes return
 * 409 Conflict instead of silently creating a half-initialized row.
 */
async function requireSettings(): Promise<PrismaAppSettings> {
  const row = await loadSettings();
  if (!row) {
    throw Object.assign(new Error('App is not installed yet'), {
      statusCode: 409,
    });
  }
  return row;
}

/**
 * Coerce a Bitrix24 userfield record into our DTO. Bitrix returns the
 * keys in SHOUTY_CASE and some of them as numeric strings.
 */
function normalizeUserField(raw: Record<string, unknown>): DealFileFieldDTO {
  const id = Number(raw.ID ?? raw.id ?? 0);
  const fieldName = String(raw.FIELD_NAME ?? '');
  const xmlId =
    typeof raw.XML_ID === 'string' && raw.XML_ID.length > 0
      ? (raw.XML_ID as string)
      : null;
  const multiple = String(raw.MULTIPLE ?? 'N').toUpperCase() === 'Y';

  // EDIT_FORM_LABEL / LIST_COLUMN_LABEL can come back as either a
  // plain string (for single-locale portals) or an object keyed by
  // locale ("ru", "en"). We prefer the user's locale if present,
  // falling back to the first non-empty entry.
  const editFormLabel = pickLocalized(raw.EDIT_FORM_LABEL);
  const listLabel = pickLocalized(raw.LIST_COLUMN_LABEL);

  return { id, fieldName, xmlId, editFormLabel, listLabel, multiple };
}

function pickLocalized(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value || null;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['ru', 'en', 'de', 'default']) {
      const v = obj[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    for (const v of Object.values(obj)) {
      if (typeof v === 'string' && v.length > 0) return v;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Route registration                                                  */
/* ------------------------------------------------------------------ */

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------------------------------------------------------- */
  /* GET /api/settings                                                 */
  /* ---------------------------------------------------------------- */
  app.get('/api/settings', async (request, reply): Promise<{ settings: AppSettings } | void> => {
    const auth = request.b24Auth;
    if (!auth) return reply.unauthorized('B24 auth payload missing');

    const row = await loadSettings();
    if (!row) {
      return reply.notFound('App is not installed yet');
    }
    return { settings: toAppSettings(row) };
  });

  /* ---------------------------------------------------------------- */
  /* PUT /api/settings                                                 */
  /* ---------------------------------------------------------------- */
  app.put<{ Body: PutSettingsBody }>('/api/settings', { preHandler: requireAdmin }, async (request, reply) => {
    const auth = request.b24Auth;
    if (!auth) return reply.unauthorized('B24 auth payload missing');

    let existing: PrismaAppSettings;
    try {
      existing = await requireSettings();
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode ?? 500;
      if (code === 409) return reply.conflict('App is not installed yet');
      throw err;
    }

    const body = request.body ?? ({} as PutSettingsBody);

    const updateData: Partial<PrismaAppSettings> = {};

    // dealFieldBinding: null or "" clears the binding.
    if ('dealFieldBinding' in body) {
      const v = body.dealFieldBinding;
      if (v === null || (typeof v === 'string' && v.length === 0)) {
        updateData.dealFieldBinding = null;
      } else if (typeof v === 'string') {
        // Allow only UF_CRM_* codes to guard against typos. Empty
        // string already handled above.
        if (!/^UF_CRM_[A-Z0-9_]+$/i.test(v)) {
          return reply.badRequest(
            'dealFieldBinding must be a UF_CRM_* field code',
          );
        }
        updateData.dealFieldBinding = v;
      }
    }

    // adminUserIds: optional replacement. Must be non-empty if present.
    if (Array.isArray(body.adminUserIds)) {
      const sanitized = Array.from(
        new Set(
          body.adminUserIds
            .map((n) => Number(n))
            .filter((n) => Number.isFinite(n) && n > 0),
        ),
      );
      if (sanitized.length === 0) {
        return reply.badRequest('adminUserIds must contain at least one id');
      }
      updateData.adminUserIds = JSON.stringify(sanitized);
    }

    if (Object.keys(updateData).length === 0) {
      return { settings: toAppSettings(existing) };
    }

    const row = await prisma.appSettings.update({
      where: { id: 1 },
      data: updateData,
    });

    // adminUserIds may have changed — drop the in-memory cache so the
    // next requireAdmin() call refetches fresh data immediately.
    if ('adminUserIds' in updateData) {
      invalidateRoleCache();
    }

    return { settings: toAppSettings(row) };
  });

  /* ---------------------------------------------------------------- */
  /* GET /api/settings/deal-fields                                     */
  /* ---------------------------------------------------------------- */
  app.get('/api/settings/deal-fields', async (request, reply) => {
    const auth = request.b24Auth;
    if (!auth) return reply.unauthorized('B24 auth payload missing');
    if (!auth.accessToken) {
      return reply.unauthorized('Missing access token in B24 auth payload');
    }

    const client = new B24Client({
      portal: auth.domain,
      accessToken: auth.accessToken,
    });

    let raw: Array<Record<string, unknown>>;
    try {
      raw = await client.listDealUserFields();
    } catch (err) {
      if (err instanceof B24Error) {
        return reply.badGateway(err.message);
      }
      throw err;
    }

    const fields = raw
      .filter((f) => {
        // USER_TYPE_ID is the real type indicator — "file" is the slot
        // where generated .docx files can be attached. Some portals
        // also expose a shortcut "type" key.
        const t =
          String(f.USER_TYPE_ID ?? f.user_type_id ?? f.type ?? '').toLowerCase();
        return t === 'file';
      })
      .map(normalizeUserField);

    return { fields };
  });

  /* ---------------------------------------------------------------- */
  /* POST /api/settings/create-field                                   */
  /* ---------------------------------------------------------------- */
  app.post<{ Body: CreateFieldBody }>(
    '/api/settings/create-field',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const auth = request.b24Auth;
      if (!auth) return reply.unauthorized('B24 auth payload missing');
      if (!auth.accessToken) {
        return reply.unauthorized('Missing access token in B24 auth payload');
      }

      const body = request.body ?? ({} as CreateFieldBody);
      const xmlId =
        typeof body.xmlId === 'string' ? body.xmlId.trim().toUpperCase() : '';
      const label = typeof body.label === 'string' ? body.label.trim() : '';
      const multiple = body.multiple === true;

      if (!xmlId || !/^[A-Z0-9_]+$/.test(xmlId)) {
        return reply.badRequest(
          'xmlId is required and may contain only A-Z, 0-9 and underscore',
        );
      }
      if (!label) {
        return reply.badRequest('label is required');
      }

      const client = new B24Client({
        portal: auth.domain,
        accessToken: auth.accessToken,
      });

      // Bitrix24 stores label-like fields as language-keyed objects.
      // Passing a flat string is silently ignored on multi-locale
      // portals, which is why freshly created fields used to show up
      // as "UF_CRM_X — UF_CRM_X" in the dropdown. Send the label for
      // every locale we care about.
      const localizedLabel = { ru: label, en: label, de: label };

      let createdId: number;
      try {
        createdId = await client.addDealUserField({
          USER_TYPE_ID: 'file',
          XML_ID: xmlId,
          FIELD_NAME: `UF_CRM_${xmlId}`,
          EDIT_FORM_LABEL: localizedLabel,
          LIST_COLUMN_LABEL: localizedLabel,
          LIST_FILTER_LABEL: localizedLabel,
          ERROR_MESSAGE: localizedLabel,
          HELP_MESSAGE: localizedLabel,
          EDIT_IN_LIST: 'Y',
          IS_SEARCHABLE: 'N',
          MULTIPLE: multiple ? 'Y' : 'N',
          MANDATORY: 'N',
          SHOW_IN_LIST: 'Y',
        });
      } catch (err) {
        if (err instanceof B24Error) {
          // Duplicate XML_ID — surface a 409 so the frontend can
          // prompt the admin to pick a different code.
          if (/already|exist|duplicate|uniq/i.test(err.message)) {
            return reply.conflict(err.message);
          }
          return reply.badGateway(err.message);
        }
        throw err;
      }

      // Re-query the list so we can return the canonical FIELD_NAME
      // (`UF_CRM_*`) that the admin should select in the dropdown.
      let fieldName = `UF_CRM_${xmlId}`;
      try {
        const list = await client.listDealUserFields();
        const match = list.find((f) => Number(f.ID ?? 0) === createdId);
        if (match) {
          const dto = normalizeUserField(match);
          fieldName = dto.fieldName || fieldName;
        }
      } catch {
        /* non-fatal — we already have a reasonable default */
      }

      return reply.code(201).send({
        field: {
          id: createdId,
          fieldName,
          xmlId,
          label,
        },
      });
    },
  );
}
