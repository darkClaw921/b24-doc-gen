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
import { Prisma, type Template as PrismaTemplate, type Formula as PrismaFormula } from '@prisma/client';
import type {
  Formula,
  FormulaDependencies,
  FormulaEvaluationResult,
  TemplatePreviewResponse,
} from '@b24-doc-gen/shared';
import { prisma } from '../prisma/client.js';
import { parseDocxToHtml, DocxParseError } from '../services/docxParser.js';
import { evaluateExpression } from '../services/formulaEngine.js';
import { B24Client } from '../services/b24Client.js';
import { getDealContext, DealDataError } from '../services/dealData.js';
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
  hasOriginalDocx: boolean;
  /** Base64 of the original .docx, only when explicitly requested. */
  originalDocxBase64?: string;
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

interface TemplateRow extends PrismaTemplate {
  formulas: PrismaFormula[];
}

function toTemplateDto(row: TemplateRow, withDocx: boolean): TemplateDTO {
  return {
    id: row.id,
    name: row.name,
    themeId: row.themeId,
    contentHtml: row.contentHtml,
    formulas: row.formulas.map(toFormulaDto),
    hasOriginalDocx: row.originalDocx !== null && row.originalDocx !== undefined,
    originalDocxBase64:
      withDocx && row.originalDocx
        ? Buffer.from(row.originalDocx).toString('base64')
        : undefined,
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
    const extras = ` data-computed-value="${escapeAttr(computed)}"${
      result.error ? ` data-formula-error="${escapeAttr(result.error)}"` : ''
    }`;
    const display = result.error
      ? `Σ ${escapeHtml(result.label)}`
      : escapeHtml(computed);
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
        include: { formulas: true },
      });
      if (!row) return reply.notFound(`template ${id} not found`);

      return { template: toTemplateDto(row, withDocx) };
    },
  );

  /* ---------------------------------------------------------------- */
  /* GET /api/templates/:id/preview?dealId=                             */
  /* ---------------------------------------------------------------- */
  /*
   * Render a "ready for preview" version of a template:
   *
   *   1) Load the template (with its formulas) from the DB.
   *   2) Resolve the deal context via `getDealContext`.
   *   3) For each formula row, evaluate its expression against the
   *      same scope.
   *   4) Rewrite the template HTML so every `<span data-formula-key>`
   *      node carries a `data-computed-value` attribute AND its text
   *      content is the computed value (or the original label on
   *      error, so admins still see something in the editor).
   *   5) Return both the rewritten HTML and a per-formula map keyed
   *      by `tagKey` so the frontend can show tooltips.
   */
  app.get<{ Params: GetTemplateParams; Querystring: PreviewTemplateQuery }>(
    '/api/templates/:id/preview',
    async (request, reply) => {
      const auth = request.b24Auth;
      if (!auth) return reply.unauthorized('B24 auth payload missing');

      const { id } = request.params;
      const dealIdRaw = request.query.dealId;
      const dealIdNum = dealIdRaw ? Number(dealIdRaw) : NaN;
      if (!Number.isFinite(dealIdNum) || dealIdNum <= 0) {
        return reply.badRequest('dealId query param is required');
      }

      const row = await prisma.template.findUnique({
        where: { id },
        include: { formulas: true },
      });
      if (!row) return reply.notFound(`template ${id} not found`);

      if (!auth.accessToken) {
        return reply.unauthorized('Missing access token in B24 auth payload');
      }

      // Load the deal context (single service, same shape everywhere).
      let context;
      try {
        const client = new B24Client({
          portal: auth.domain,
          accessToken: auth.accessToken,
        });
        context = await getDealContext(client, dealIdNum);
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

      // Rewrite the HTML so formula placeholders display their
      // computed value. We use a tolerant regex on the <span> — the
      // HTML is produced by TipTap so it's always well-formed and
      // self-contained, and using cheerio would add a runtime
      // dependency we don't otherwise need.
      const html = substituteFormulaTagsForPreview(row.contentHtml, formulaResults);

      const response: TemplatePreviewResponse = {
        html,
        formulas: formulaResults,
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
      include: { formulas: true },
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

    // Persist the template.
    const row = await prisma.template.create({
      data: {
        name,
        themeId,
        contentHtml: html.length > 0 ? html : '<p></p>',
        originalDocx: buffer,
      },
      include: { formulas: true },
    });

    return reply.code(201).send({
      template: toTemplateDto(row, false),
      warnings: messages,
    });
  });

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

          return tx.template.findUnique({
            where: { id },
            include: { formulas: true },
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
      // Cascade-delete formulas first to satisfy the foreign key.
      await prisma.formula.deleteMany({ where: { templateId: id } });
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
