/**
 * Template routes — CRUD for document templates plus a multipart
 * upload endpoint that converts a `.docx` file into HTML on the fly.
 *
 *  - `GET    /api/templates?themeId=&search=` — list templates,
 *      optionally filtered by theme and free-text name search.
 *  - `GET    /api/templates/:id`              — full template incl.
 *      `formulas[]`. Does NOT return the original `.docx` bytes by
 *      default; clients can pass `?withDocx=1` to get a base64 copy.
 *  - `POST   /api/templates`                  — create an empty
 *      template (no .docx) — used by the editor when starting from
 *      scratch instead of uploading.
 *  - `POST   /api/templates/upload`           — multipart upload of
 *      a `.docx` file. The handler reads the file via
 *      `request.file().toBuffer()`, parses it through `docxParser`,
 *      and creates a new template row with `contentHtml` + the
 *      original bytes saved into `originalDocx`.
 *  - `PUT    /api/templates/:id`              — update name, themeId,
 *      contentHtml and the formulas array. Performed inside a
 *      transaction so removed formulas are deleted and new ones
 *      created atomically.
 *  - `DELETE /api/templates/:id`              — remove a template
 *      (Prisma cascade-deletes its formulas).
 *
 * Mutation routes are auth-gated by the global B24 middleware (which
 * exposes `request.b24Auth.userId`). Admin role enforcement is added
 * in Phase 6 (bz3.1).
 */

import type { FastifyInstance } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import {
  Prisma,
  type Template as PrismaTemplate,
  type Formula as PrismaFormula,
  type TemplateField as PrismaTemplateField,
} from '@prisma/client';
import type {
  Formula,
  FormulaDependencies,
  FormulaEvaluationResult,
  TemplateField,
  TemplateFieldType,
  TemplatePreviewRequest,
  TemplatePreviewResponse,
} from '@b24-doc-gen/shared';
import { prisma } from '../prisma/client.js';
import { parseDocxToHtml, DocxParseError } from '../services/docxParser.js';
import { evaluateExpression } from '../services/formulaEngine.js';
import { B24Client } from '../services/b24Client.js';
import { getDealContext, DealDataError } from '../services/dealData.js';
import {
  buildDocxFromTemplate,
  scanDocxPlaceholders,
  DocxTemplateError,
} from '../services/docxTemplateEngine.js';
import { resolveManualFieldValues } from '../services/generationPipeline.js';
import { replaceBase64WithUrls, cacheImage } from '../services/imageCache.js';
import { requireAdmin } from '../middleware/role.js';

/* ------------------------------------------------------------------ */
/* DTOs                                                                */
/* ------------------------------------------------------------------ */

export interface TemplateListItemDTO {
  id: string;
  name: string;
  themeId: string;
  themeName?: string;
  formulasCount: number;
  hasOriginalDocx: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateDTO {
  id: string;
  name: string;
  themeId: string;
  contentHtml: string;
  formulas: Formula[];
  fields: TemplateField[];
  hasOriginalDocx: boolean;
  /** Base64 of the original .docx, only when explicitly requested. */
  originalDocxBase64?: string;
  /**
   * Placeholder tags scanned from the original `.docx` (via
   * `scanDocxPlaceholders`). Populated only when `withDocx` is requested
   * and an original `.docx` is stored. Used by the editor to list every
   * template tag and highlight the ones without a formula/manual-field
   * binding. Undefined when not requested or no `.docx` is available.
   */
  docxPlaceholders?: string[];
  createdAt: string;
  updatedAt: string;
}

interface ListTemplatesQuery {
  themeId?: string;
  search?: string;
}

interface GetTemplateParams {
  id: string;
}

interface GetTemplateQuery {
  withDocx?: string;
}

interface PreviewTemplateQuery {
  dealId?: string;
}

interface CreateTemplateBody {
  name: string;
  themeId: string;
  contentHtml?: string;
}

interface UpdateTemplateBody {
  name?: string;
  themeId?: string;
  contentHtml?: string;
  formulas?: FormulaInput[];
  fields?: TemplateFieldInput[];
}

/** Shape of a formula sent by the client when saving a template. */
export interface FormulaInput {
  /** Optional id — if present we try to update; otherwise we create. */
  id?: string;
  tagKey: string;
  label: string;
  expression: string;
  dependsOn: FormulaDependencies;
}

/** Shape of a manual field sent by the client when saving a template. */
export interface TemplateFieldInput {
  id?: string;
  fieldKey: string;
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
  order?: number;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function safeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  return trimmed;
}

function safeContentHtml(value: unknown): string {
  if (typeof value !== 'string') return '';
  // Hard cap to keep SQLite rows reasonable. 5 MB of HTML is a lot.
  if (value.length > 5 * 1024 * 1024) {
    throw new Error('contentHtml exceeds 5MB limit');
  }
  return value;
}

function parseDependsOn(raw: string): FormulaDependencies {
  try {
    const parsed = JSON.parse(raw) as Partial<FormulaDependencies>;
    return {
      deal: Array.isArray(parsed.deal) ? parsed.deal.map(String) : [],
      contact: Array.isArray(parsed.contact) ? parsed.contact.map(String) : [],
      company: Array.isArray(parsed.company) ? parsed.company.map(String) : [],
    };
  } catch {
    return { deal: [], contact: [], company: [] };
  }
}

function serializeDependsOn(deps: FormulaDependencies | undefined): string {
  return JSON.stringify({
    deal: Array.isArray(deps?.deal) ? deps!.deal.map(String) : [],
    contact: Array.isArray(deps?.contact) ? deps!.contact.map(String) : [],
    company: Array.isArray(deps?.company) ? deps!.company.map(String) : [],
  });
}

function toFormulaDto(row: PrismaFormula): Formula {
  return {
    id: row.id,
    templateId: row.templateId,
    tagKey: row.tagKey,
    label: row.label,
    expression: row.expression,
    dependsOn: parseDependsOn(row.dependsOn),
  };
}

/** Allowed manual-field types; anything else falls back to "text". */
const FIELD_TYPES: TemplateFieldType[] = ['text', 'textarea', 'number', 'date'];

function normalizeFieldType(value: unknown): TemplateFieldType {
  return FIELD_TYPES.includes(value as TemplateFieldType)
    ? (value as TemplateFieldType)
    : 'text';
}

function toTemplateFieldDto(row: PrismaTemplateField): TemplateField {
  return {
    id: row.id,
    templateId: row.templateId,
    fieldKey: row.fieldKey,
    label: row.label,
    type: normalizeFieldType(row.type),
    required: row.required,
    placeholder: row.placeholder ?? undefined,
    defaultValue: row.defaultValue ?? undefined,
    order: row.order,
  };
}

/** Allowed default-value tokens. Anything else is dropped (no default). */
const FIELD_DEFAULTS = new Set(['today']);

/**
 * Validate and normalize the manual-field array sent by the client.
 * Drops entries with an empty fieldKey and de-duplicates by fieldKey
 * (last write wins). `order` is derived from array position so the
 * generate form reflects the order in which the admin authored them.
 */
function normalizeFieldsInput(
  fields: TemplateFieldInput[],
): Array<{
  fieldKey: string;
  label: string;
  type: TemplateFieldType;
  required: boolean;
  placeholder: string | null;
  defaultValue: string | null;
  order: number;
}> {
  const byKey = new Map<string, ReturnType<typeof normalizeFieldsInput>[number]>();
  fields.forEach((f, index) => {
    const fieldKey = String(f.fieldKey ?? '').trim();
    if (!fieldKey) return;
    const placeholder =
      typeof f.placeholder === 'string' && f.placeholder.trim().length > 0
        ? f.placeholder.trim()
        : null;
    const type = normalizeFieldType(f.type);
    // Default value: for `date` it must be a known token (e.g. "today");
    // for text/textarea/number it is an arbitrary literal the user can
    // edit at generation time (trimmed, length-capped).
    let defaultValue: string | null = null;
    if (typeof f.defaultValue === 'string') {
      if (type === 'date') {
        defaultValue = FIELD_DEFAULTS.has(f.defaultValue) ? f.defaultValue : null;
      } else {
        const trimmed = f.defaultValue.trim();
        defaultValue = trimmed.length > 0 ? trimmed.slice(0, 2000) : null;
      }
    }
    byKey.set(fieldKey, {
      fieldKey,
      label: String(f.label ?? '').trim() || fieldKey,
      type,
      required: Boolean(f.required),
      placeholder,
      defaultValue,
      order: typeof f.order === 'number' ? f.order : index,
    });
  });
  return Array.from(byKey.values());
}

interface TemplateRow extends PrismaTemplate {
  formulas: PrismaFormula[];
  fields: PrismaTemplateField[];
}

function toTemplateDto(row: TemplateRow, withDocx: boolean): TemplateDTO {
  const hasOriginalDocx = row.originalDocx !== null && row.originalDocx !== undefined;
  // When the caller asks for the .docx we also scan it for placeholder
  // tags so the editor can drive its "Теги шаблона" panel off a single
  // request (no deal context needed, unlike the preview endpoint).
  let docxPlaceholders: string[] | undefined;
  if (withDocx && hasOriginalDocx && row.originalDocx) {
    const docxBuffer = Buffer.isBuffer(row.originalDocx)
      ? row.originalDocx
      : Buffer.from(row.originalDocx);
    docxPlaceholders = scanDocxPlaceholders(docxBuffer);
  }
  return {
    id: row.id,
    name: row.name,
    themeId: row.themeId,
    contentHtml: row.contentHtml,
    formulas: row.formulas.map(toFormulaDto),
    fields: row.fields
      .slice()
      .sort((a, b) => a.order - b.order)
      .map(toTemplateFieldDto),
    hasOriginalDocx,
    originalDocxBase64:
      withDocx && row.originalDocx
        ? Buffer.from(row.originalDocx).toString('base64')
        : undefined,
    docxPlaceholders,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface TemplateListRow extends PrismaTemplate {
  theme: { name: string } | null;
  _count: { formulas: number };
}

/**
 * Rewrite every `<span data-formula-key="…">` node inside `html` so it
 * carries `data-computed-value` and its inner text is the computed
 * value (or the original label on error). The TipTap-rendered span has
 * a stable shape — `<span ... data-formula-key="X" ...>...</span>` —
 * so a tolerant regex is safe and avoids pulling in cheerio.
 *
 * The two flags it preserves:
 *   - data-formula-key, -label, -expression  → still needed by the
 *     frontend to render the FormulaTag pill in preview mode.
 *   - data-computed-value="…"                → new attribute that
 *     carries the evaluated value for the frontend tooltip.
 *   - data-formula-error="…" (optional)      → set if evaluation
 *     failed; the frontend renders an error badge.
 */
function substituteFormulaTagsForPreview(
  html: string,
  formulas: Record<string, FormulaEvaluationResult>,
): string {
  if (!html || Object.keys(formulas).length === 0) return html;
  // Match: <span ... data-formula-key="KEY" ...> ... </span>
  // The "..." inside the open tag is non-greedy so we don't swallow
  // a nested span. The inner content is non-greedy as well so two
  // adjacent spans don't merge.
  const re = /<span\b([^>]*?)data-formula-key=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/span>/gi;
  return html.replace(re, (_match, before: string, tagKey: string, after: string, _inner: string) => {
    const result = formulas[tagKey];
    const attrs = `${before}data-formula-key="${escapeAttr(tagKey)}"${after}`;
    if (!result) {
      return `<span${attrs}></span>`;
    }
    const computed = result.value ?? '';
    const isImage = computed.startsWith('data:image/');
    // For image values, store a short marker instead of the full base64
    // in the data attribute (it would bloat the HTML and break tooltips).
    const computedAttr = isImage ? '[image]' : computed;
    const extras = ` data-computed-value="${escapeAttr(computedAttr)}"${
      result.error ? ` data-formula-error="${escapeAttr(result.error)}"` : ''
    }`;
    let display: string;
    if (result.error) {
      display = `Σ ${escapeHtml(result.label)}`;
    } else if (isImage) {
      // Render the image inline instead of showing the base64 as text.
      display = `<img src="${computed}" style="max-width:200px;max-height:200px;display:inline-block;" />`;
    } else {
      display = escapeHtml(computed);
    }
    return `<span${attrs}${extras}>${display}</span>`;
  });
}

/** Minimal HTML attribute escaper. */
function escapeAttr(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Minimal HTML text escaper (preserves spaces). */
function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function toTemplateListDto(row: TemplateListRow): TemplateListItemDTO {
  return {
    id: row.id,
    name: row.name,
    themeId: row.themeId,
    themeName: row.theme?.name,
    formulasCount: row._count.formulas,
    hasOriginalDocx: row.originalDocx !== null && row.originalDocx !== undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Route registration                                                  */
/* ------------------------------------------------------------------ */

export async function registerTemplateRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------------------------------------------------------- */
  /* GET /api/templates?themeId=&search=                                */
  /* ---------------------------------------------------------------- */
  app.get<{ Querystring: ListTemplatesQuery }>('/api/templates', async (request, reply) => {
    const auth = request.b24Auth;
    if (!auth) return reply.unauthorized('B24 auth payload missing');

    const { themeId, search } = request.query;
    const where: Prisma.TemplateWhereInput = {};
    if (themeId && themeId.length > 0) {
      where.themeId = themeId;
    }
    if (search && search.trim().length > 0) {
      where.name = { contains: search.trim() };
    }

    const rows = await prisma.template.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }],
      include: {
        theme: { select: { name: true } },
        _count: { select: { formulas: true } },
      },
    });

    return { templates: rows.map(toTemplateListDto) };
  });

  /* ---------------------------------------------------------------- */
  /* GET /api/templates/:id                                             */
  /* ---------------------------------------------------------------- */
  app.get<{ Params: GetTemplateParams; Querystring: GetTemplateQuery }>(
    '/api/templates/:id',
    async (request, reply) => {
      const auth = request.b24Auth;
      if (!auth) return reply.unauthorized('B24 auth payload missing');

      const { id } = request.params;
      const withDocx = request.query.withDocx === '1' || request.query.withDocx === 'true';

      const row = await prisma.template.findUnique({
        where: { id },
        include: { formulas: true, fields: true },
      });
      if (!row) return reply.notFound(`template ${id} not found`);

      return { template: toTemplateDto(row, withDocx) };
    },
  );

  /* ---------------------------------------------------------------- */
  /* POST /api/templates/:id/preview                                   */
  /* ---------------------------------------------------------------- */
  /*
   * Build a fully-substituted `.docx` preview of a template:
   *
   *   1) Load the template (with its formulas + fields) from the DB.
   *   2) Resolve the deal context via `getDealContext` (same single
   *      source of truth as generation), fetching product rows/images
   *      only when the template uses them.
   *   3) Evaluate every formula against that scope.
   *   4) Resolve manual `fieldValues` (caller-provided override the
   *      configured defaults; absent keys fall back to defaults) using
   *      the same `resolveManualFieldValues` helper as generation.
   *   5) Substitute formulas + products + field values directly into the
   *      admin-uploaded original `.docx` via `buildDocxFromTemplate`,
   *      preserving all Word formatting (no HTML→PDF step).
   *   6) Return the substituted `.docx` base64-encoded together with the
   *      placeholder `tags` (from `scanDocxPlaceholders`), the per-formula
   *      results and the template's manual fields.
   */
  app.post<{ Params: GetTemplateParams; Body: TemplatePreviewRequest }>(
    '/api/templates/:id/preview',
    async (request, reply) => {
      const auth = request.b24Auth;
      if (!auth) return reply.unauthorized('B24 auth payload missing');

      const { id } = request.params;
      const body = request.body ?? ({} as TemplatePreviewRequest);
      const dealIdNum = Number(body.dealId);
      if (!Number.isFinite(dealIdNum) || dealIdNum <= 0) {
        return reply.badRequest('dealId is required');
      }
      const rawFieldValues = body.fieldValues;

      const row = await prisma.template.findUnique({
        where: { id },
        include: { formulas: true, fields: true },
      });
      if (!row) return reply.notFound(`template ${id} not found`);

      if (!auth.accessToken) {
        return reply.unauthorized('Missing access token in B24 auth payload');
      }

      // Guard: preview substitutes into the original .docx — without it
      // there is nothing to render.
      if (!row.originalDocx || row.originalDocx.length === 0) {
        return reply.badRequest(`template ${id} has no originalDocx`);
      }
      const originalDocx = Buffer.isBuffer(row.originalDocx)
        ? row.originalDocx
        : Buffer.from(row.originalDocx);

      // Detect if the template uses product rows / images so we only
      // fetch them when needed (same logic as generate.ts).
      const expressions = row.formulas.map((f) => f.expression);
      const hasProductTable = row.contentHtml.includes('data-product-table')
        || row.contentHtml.includes('data-product-field');
      const hasProductImageAttr = row.contentHtml.includes('data-product-image');
      const productHelperRe = /product(?:Sum|Count|Get|Image)\s*\(/i;
      const productImageHelperRe = /productImage\s*\(/i;
      let hasProductHelper = false;
      let hasProductImageHelper = false;
      for (const expr of expressions) {
        if (productHelperRe.test(expr)) hasProductHelper = true;
        if (productImageHelperRe.test(expr)) hasProductImageHelper = true;
      }
      const fetchProducts = hasProductTable || hasProductHelper;
      const fetchProductImages = hasProductImageAttr || hasProductImageHelper;

      // Load the deal context (single service, same shape everywhere).
      let context;
      try {
        const client = new B24Client({
          portal: auth.domain,
          accessToken: auth.accessToken,
        });
        context = await getDealContext(client, dealIdNum, {
          fetchProducts,
          fetchProductImages,
        });
      } catch (err) {
        if (err instanceof DealDataError) {
          if (err.status === 404) return reply.notFound(err.message);
          if (err.status === 400) return reply.badRequest(err.message);
          return reply.badGateway(err.message);
        }
        throw err;
      }

      // Evaluate each formula and build a map keyed by tagKey.
      const formulaResults: Record<string, FormulaEvaluationResult> = {};
      for (const f of row.formulas) {
        const result = evaluateExpression(f.expression, context);
        formulaResults[f.tagKey] = {
          tagKey: f.tagKey,
          label: f.label,
          expression: f.expression,
          value: result.value,
          rawValue: result.raw,
          error: result.error,
        };
      }

      // Resolve manual field values — caller-provided values override
      // each field's default; absent keys fall back to the default
      // (e.g. date "today"). Same helper used by the generation pipeline.
      const fieldValues = resolveManualFieldValues(row.fields, rawFieldValues);

      // Substitute formulas, products and field values directly into the
      // original .docx, preserving all Word formatting.
      let docxBuffer: Buffer;
      try {
        docxBuffer = await buildDocxFromTemplate(originalDocx, {
          formulas: formulaResults,
          products: context.PRODUCTS ?? [],
          fieldValues,
          title: row.name,
        });
      } catch (err) {
        if (err instanceof DocxTemplateError) {
          return reply.badRequest(err.message);
        }
        throw err;
      }

      // Collect the placeholder tags from the original .docx so the
      // editor can highlight/bind unresolved placeholders.
      const tags = scanDocxPlaceholders(originalDocx);

      const response: TemplatePreviewResponse = {
        docxBase64: docxBuffer.toString('base64'),
        tags,
        formulas: formulaResults,
        fields: row.fields
          .slice()
          .sort((a, b) => a.order - b.order)
          .map(toTemplateFieldDto),
      };
      return response;
    },
  );

  /* ---------------------------------------------------------------- */
  /* POST /api/templates — create empty template (no .docx)             */
  /* ---------------------------------------------------------------- */
  app.post<{ Body: CreateTemplateBody }>('/api/templates', { preHandler: requireAdmin }, async (request, reply) => {
    const auth = request.b24Auth;
    if (!auth) return reply.unauthorized('B24 auth payload missing');

    const body = request.body ?? ({} as CreateTemplateBody);
    const name = safeName(body.name);
    if (!name) return reply.badRequest('name is required');
    if (!body.themeId) return reply.badRequest('themeId is required');

    const themeExists = await prisma.theme.findUnique({ where: { id: body.themeId } });
    if (!themeExists) return reply.badRequest(`theme ${body.themeId} not found`);

    const row = await prisma.template.create({
      data: {
        name,
        themeId: body.themeId,
        contentHtml: typeof body.contentHtml === 'string' ? body.contentHtml : '<p></p>',
      },
      include: { formulas: true, fields: true },
    });

    return reply.code(201).send({ template: toTemplateDto(row, false) });
  });

  /* ---------------------------------------------------------------- */
  /* POST /api/templates/upload — multipart .docx upload                */
  /* ---------------------------------------------------------------- */
  app.post('/api/templates/upload', { preHandler: requireAdmin }, async (request, reply) => {
    const auth = request.b24Auth;
    if (!auth) return reply.unauthorized('B24 auth payload missing');

    if (!request.isMultipart()) {
      return reply.badRequest('Expected multipart/form-data');
    }

    let filePart: MultipartFile | undefined;
    try {
      filePart = await request.file({
        limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.badRequest(`upload failed: ${message}`);
    }

    if (!filePart) {
      return reply.badRequest('file field is required');
    }

    // Validate mime / extension early.
    const filename = filePart.filename ?? '';
    const isDocx =
      /\.docx$/i.test(filename) ||
      filePart.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (!isDocx) {
      return reply.badRequest('only .docx files are accepted');
    }

    // Pull other form fields from the parsed file part.
    const fields = filePart.fields as Record<string, { value?: unknown } | undefined>;
    const nameField = fields?.name?.value;
    const themeIdField = fields?.themeId?.value;
    const name = safeName(nameField) ?? safeName(filename.replace(/\.docx$/i, ''));
    const themeId = typeof themeIdField === 'string' ? themeIdField : undefined;

    if (!name) return reply.badRequest('name is required');
    if (!themeId) return reply.badRequest('themeId is required');

    const themeExists = await prisma.theme.findUnique({ where: { id: themeId } });
    if (!themeExists) return reply.badRequest(`theme ${themeId} not found`);

    // Buffer the file in memory. 20 MB max.
    let buffer: Buffer;
    try {
      buffer = await filePart.toBuffer();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.payloadTooLarge(`failed to read upload: ${message}`);
    }

    if (filePart.file.truncated) {
      return reply.payloadTooLarge('file exceeds 20MB limit');
    }

    // Convert .docx → HTML.
    let html = '';
    let messages: string[] = [];
    try {
      const parsed = await parseDocxToHtml(buffer);
      html = parsed.html;
      messages = parsed.messages;
    } catch (err) {
      if (err instanceof DocxParseError) {
        return reply.badRequest(err.message);
      }
      throw err;
    }

    // Scan the original .docx for template placeholders.
    let docxPlaceholders: string[] = [];
    try {
      docxPlaceholders = scanDocxPlaceholders(buffer);
    } catch {
      // Non-fatal — the template is still valid, just without placeholder info.
      messages.push('Could not scan .docx for placeholders');
    }

    // Persist the template.
    const row = await prisma.template.create({
      data: {
        name,
        themeId,
        contentHtml: html.length > 0 ? html : '<p></p>',
        originalDocx: buffer,
      },
      include: { formulas: true, fields: true },
    });

    return reply.code(201).send({
      template: toTemplateDto(row, false),
      warnings: messages,
      docxPlaceholders,
    });
  });

  /* ---------------------------------------------------------------- */
  /* PUT /api/templates/:id/docx — replace original .docx               */
  /* ---------------------------------------------------------------- */
  app.put<{ Params: GetTemplateParams }>(
    '/api/templates/:id/docx',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const auth = request.b24Auth;
      if (!auth) return reply.unauthorized('B24 auth payload missing');

      const { id } = request.params;

      // The template must already exist — this is an update, not a create.
      const existing = await prisma.template.findUnique({ where: { id } });
      if (!existing) return reply.notFound(`template ${id} not found`);

      if (!request.isMultipart()) {
        return reply.badRequest('Expected multipart/form-data');
      }

      let filePart: MultipartFile | undefined;
      try {
        filePart = await request.file({
          limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.badRequest(`upload failed: ${message}`);
      }

      if (!filePart) {
        return reply.badRequest('file field is required');
      }

      // Validate mime / extension early.
      const filename = filePart.filename ?? '';
      const isDocx =
        /\.docx$/i.test(filename) ||
        filePart.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      if (!isDocx) {
        return reply.badRequest('only .docx files are accepted');
      }

      // Buffer the file in memory. 20 MB max.
      let buffer: Buffer;
      try {
        buffer = await filePart.toBuffer();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.payloadTooLarge(`failed to read upload: ${message}`);
      }

      if (filePart.file.truncated) {
        return reply.payloadTooLarge('file exceeds 20MB limit');
      }

      // Convert .docx → HTML (legacy/search fallback).
      let html = '';
      let messages: string[] = [];
      try {
        const parsed = await parseDocxToHtml(buffer);
        html = parsed.html;
        messages = parsed.messages;
      } catch (err) {
        if (err instanceof DocxParseError) {
          return reply.badRequest(err.message);
        }
        throw err;
      }

      // Scan the new .docx for template placeholders.
      let docxPlaceholders: string[] = [];
      try {
        docxPlaceholders = scanDocxPlaceholders(buffer);
      } catch {
        // Non-fatal — the template is still valid, just without placeholder info.
        messages.push('Could not scan .docx for placeholders');
      }

      // Replace the stored original bytes and refresh the cached HTML.
      const row = await prisma.template.update({
        where: { id },
        data: {
          originalDocx: buffer,
          contentHtml: html.length > 0 ? html : '<p></p>',
        },
        include: { formulas: true, fields: true },
      });

      // 200 — this is an update of an existing template, not a creation.
      return reply.send({
        template: toTemplateDto(row, false),
        warnings: messages,
        docxPlaceholders,
      });
    },
  );

  /* ---------------------------------------------------------------- */
  /* PUT /api/templates/:id                                             */
  /* ---------------------------------------------------------------- */
  app.put<{ Params: GetTemplateParams; Body: UpdateTemplateBody }>(
    '/api/templates/:id',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const auth = request.b24Auth;
      if (!auth) return reply.unauthorized('B24 auth payload missing');

      const { id } = request.params;
      const body = request.body ?? ({} as UpdateTemplateBody);

      const updateData: Prisma.TemplateUpdateInput = {};
      if (body.name !== undefined) {
        const name = safeName(body.name);
        if (!name) return reply.badRequest('name must be 1..200 chars');
        updateData.name = name;
      }
      if (body.themeId !== undefined) {
        const themeExists = await prisma.theme.findUnique({ where: { id: body.themeId } });
        if (!themeExists) return reply.badRequest(`theme ${body.themeId} not found`);
        updateData.theme = { connect: { id: body.themeId } };
      }
      if (body.contentHtml !== undefined) {
        try {
          updateData.contentHtml = safeContentHtml(body.contentHtml);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return reply.badRequest(message);
        }
      }

      const formulasInput = Array.isArray(body.formulas) ? body.formulas : null;
      const fieldsInput = Array.isArray(body.fields)
        ? normalizeFieldsInput(body.fields)
        : null;

      try {
        const updated = await prisma.$transaction(async (tx) => {
          const exists = await tx.template.findUnique({ where: { id } });
          if (!exists) {
            throw new Prisma.PrismaClientKnownRequestError('not found', {
              code: 'P2025',
              clientVersion: 'tx',
            });
          }

          await tx.template.update({ where: { id }, data: updateData });

          // Replace the formula set if the client provided one.
          // Empty array = "remove all formulas".
          if (formulasInput !== null) {
            await tx.formula.deleteMany({ where: { templateId: id } });
            if (formulasInput.length > 0) {
              await tx.formula.createMany({
                data: formulasInput.map((f) => ({
                  templateId: id,
                  tagKey: String(f.tagKey ?? '').trim(),
                  label: String(f.label ?? '').trim(),
                  expression: String(f.expression ?? '').trim(),
                  dependsOn: serializeDependsOn(f.dependsOn),
                })),
              });
            }
          }

          // Replace the manual-field set if the client provided one.
          // Empty array = "remove all fields".
          if (fieldsInput !== null) {
            await tx.templateField.deleteMany({ where: { templateId: id } });
            if (fieldsInput.length > 0) {
              await tx.templateField.createMany({
                data: fieldsInput.map((f) => ({
                  templateId: id,
                  fieldKey: f.fieldKey,
                  label: f.label,
                  type: f.type,
                  required: f.required,
                  placeholder: f.placeholder,
                  defaultValue: f.defaultValue,
                  order: f.order,
                })),
              });
            }
          }

          return tx.template.findUnique({
            where: { id },
            include: { formulas: true, fields: true },
          });
        });

        if (!updated) return reply.notFound(`template ${id} not found`);
        return { template: toTemplateDto(updated, false) };
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2025'
        ) {
          return reply.notFound(`template ${id} not found`);
        }
        throw err;
      }
    },
  );

  /* ---------------------------------------------------------------- */
  /* DELETE /api/templates/:id                                          */
  /* ---------------------------------------------------------------- */
  app.delete<{ Params: GetTemplateParams }>('/api/templates/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const auth = request.b24Auth;
    if (!auth) return reply.unauthorized('B24 auth payload missing');

    const { id } = request.params;
    try {
      // Cascade-delete formulas and manual fields first to satisfy the
      // foreign keys.
      await prisma.formula.deleteMany({ where: { templateId: id } });
      await prisma.templateField.deleteMany({ where: { templateId: id } });
      await prisma.template.delete({ where: { id } });
      return reply.code(204).send();
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        return reply.notFound(`template ${id} not found`);
      }
      throw err;
    }
  });
}
