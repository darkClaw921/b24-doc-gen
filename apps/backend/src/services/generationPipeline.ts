/**
 * Shared document-generation pipeline.
 *
 * This is the framework-agnostic core of the `.docx` generation flow.
 * It was extracted out of `routes/generate.ts` so that multiple entry
 * points — the authenticated UI button (`POST /api/generate`), the
 * bizproc robot handler (`POST /api/bizproc/robot/run`) and the
 * outgoing-webhook runner (`POST /api/webhook/run/:token`) — can all
 * execute the exact same steps without duplicating logic and without
 * dragging a `FastifyRequest/Reply` into the service layer.
 *
 * Responsibilities (steps 1-9, preserved from the original inline
 * implementation):
 *   1. Load the Template (+ formulas + theme) by id.
 *   2. Load AppSettings and compute effective per-template overrides
 *      (dealFieldBinding from theme → fallback to AppSettings;
 *      addToTimeline from theme).
 *   3. Build the deal context via `getDealContext` — single source of
 *      truth shared with `GET /api/templates/:id/preview`.
 *   4. Evaluate every formula and capture per-tag results.
 *   5. `buildDocxFromTemplate(template.originalDocx, …)` → Node Buffer
 *      (formulas + manual fieldValues + product rows substituted directly
 *      into the original .docx).
 *   6. `disk.storage.getforapp` → folder id, then `disk.folder.uploadfile`
 *      via `client.uploadDiskFile`.
 *   7. (Optional) attach the uploaded file to the deal's `UF_CRM_*`
 *      field with `crm.item.update` (non-fatal on failure).
 *   8. (Optional) post a timeline comment with the file attachment
 *      (non-fatal on failure).
 *   9. Return a structured result.
 *
 * The function NEVER throws for business-logic problems (template not
 * found, bad dealId, .docx build failure, B24 REST failure). Instead
 * it encodes them in a `GenerationError` wrapper so callers can map
 * them to whatever response envelope they need (HTTP status codes,
 * bizproc ack, webhook result array, etc).
 */

import type { FastifyBaseLogger } from 'fastify';
import type { FormulaEvaluationResult, GenerateResponse } from '@b24-doc-gen/shared';
import { prisma } from '../prisma/client.js';
import { B24Client, B24Error } from './b24Client.js';
import { getDealContext, DealDataError } from './dealData.js';
import { evaluateExpression } from './formulaEngine.js';
import { buildDocxFromTemplate, DocxTemplateError } from './docxTemplateEngine.js';
import { toAppSettings } from '../routes/install.js';

/* ------------------------------------------------------------------ */
/* Public result shape                                                  */
/* ------------------------------------------------------------------ */

/**
 * Sub-result for the optional "attach to UF_CRM_* field" step. Mirrors
 * the shape that `routes/generate.ts` has always returned so the
 * existing UI keeps rendering the yellow-warning state correctly.
 */
export interface BindingResult {
  fieldName: string;
  ok: boolean;
  error?: string;
}

export interface GenerationResult extends GenerateResponse {
  /** Computed file name as it appears on the Bitrix24 disk. */
  fileName: string;
  /** Per-formula evaluation map (so the UI can show what was used). */
  formulas: Record<string, FormulaEvaluationResult>;
  /** Result of the optional UF_CRM_* attach step (null if none configured). */
  binding: BindingResult | null;
  /** Result of the timeline-comment step. */
  timeline: { ok: boolean; commentId?: number; error?: string };
  /** Non-fatal notices (e.g. "dealFieldBinding not configured"). */
  warnings: string[];
}

/**
 * Error kinds distinguishable by the caller. The HTTP layer maps these
 * to status codes; the webhook runner records them in the per-template
 * results array without aborting the whole call.
 */
export type GenerationErrorKind =
  | 'template_not_found'
  | 'bad_deal_id'
  | 'deal_not_found'
  | 'deal_gateway'
  | 'docx_build_failed'
  | 'disk_gateway'
  | 'upload_failed'
  | 'unexpected';

export class GenerationError extends Error {
  readonly kind: GenerationErrorKind;

  constructor(kind: GenerationErrorKind, message: string) {
    super(message);
    this.name = 'GenerationError';
    this.kind = kind;
  }
}

/* ------------------------------------------------------------------ */
/* Parameters                                                           */
/* ------------------------------------------------------------------ */

export interface RunGenerationParams {
  /** Template primary key (cuid string). */
  templateId: string;
  /** CRM deal id (positive integer). */
  dealId: number;
  /** Pre-built B24Client (caller decides how it's authenticated). */
  client: B24Client;
  /** Logger — Fastify child logger, or any pino-compatible instance. */
  logger: FastifyBaseLogger;
  /**
   * Values for the template's manual fields, keyed by fieldKey. Optional
   * because server-to-server callers (e.g. the webhook runner) have no
   * user to fill them in — in that case the fields render empty.
   */
  fieldValues?: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/* runGeneration                                                        */
/* ------------------------------------------------------------------ */

/**
 * Execute the full generation pipeline for a single (templateId, dealId)
 * pair. See the file header for the step list.
 *
 * Throws `GenerationError` on any deterministic failure; lets genuinely
 * unexpected errors propagate so they surface as 500s upstream.
 */
export async function runGeneration(
  params: RunGenerationParams,
): Promise<GenerationResult> {
  const { templateId, dealId, client, logger, fieldValues: rawFieldValues } = params;

  /* -------------------------------------------------------------- */
  /* 1) Load the template + formulas + fields                       */
  /* -------------------------------------------------------------- */
  const template = await prisma.template.findUnique({
    where: { id: templateId },
    include: { formulas: true, theme: true, fields: true },
  });
  if (!template) {
    throw new GenerationError('template_not_found', `template ${templateId} not found`);
  }

  const settingsRow = await prisma.appSettings.findUnique({ where: { id: 1 } });
  const settings = settingsRow ? toAppSettings(settingsRow) : null;

  // Effective per-template generation settings: theme overrides win.
  // dealFieldBinding falls back to AppSettings only when the theme has
  // no per-folder override; addToTimeline is always taken from the theme.
  const effectiveFieldBinding =
    template.theme.dealFieldBinding ?? settings?.dealFieldBinding ?? null;
  const effectiveAddToTimeline = template.theme.addToTimeline;

  if (!Number.isFinite(dealId) || dealId <= 0) {
    throw new GenerationError('bad_deal_id', 'dealId must be a positive number');
  }

  /* -------------------------------------------------------------- */
  /* 2) Determine if product data is needed                         */
  /* -------------------------------------------------------------- */
  const { fetchProducts, fetchProductImages } = detectProductUsage(
    template.contentHtml,
    template.formulas.map((f) => f.expression),
  );

  /* -------------------------------------------------------------- */
  /* 3) Build deal context                                          */
  /* -------------------------------------------------------------- */
  let context;
  try {
    context = await getDealContext(client, dealId, {
      fetchProducts,
      fetchProductImages,
    });
  } catch (err) {
    if (err instanceof DealDataError) {
      if (err.status === 404) {
        throw new GenerationError('deal_not_found', err.message);
      }
      if (err.status === 400) {
        throw new GenerationError('bad_deal_id', err.message);
      }
      throw new GenerationError('deal_gateway', err.message);
    }
    throw err;
  }

  /* -------------------------------------------------------------- */
  /* 3) Evaluate every formula                                      */
  /* -------------------------------------------------------------- */
  const formulaResults: Record<string, FormulaEvaluationResult> = {};
  for (const f of template.formulas) {
    const r = evaluateExpression(f.expression, context);
    formulaResults[f.tagKey] = {
      tagKey: f.tagKey,
      label: f.label,
      expression: f.expression,
      value: r.value,
      rawValue: r.raw,
      error: r.error,
    };
  }

  const warnings: string[] = [];

  /* -------------------------------------------------------------- */
  /* 3b) Resolve manual field values                                */
  /* -------------------------------------------------------------- */
  // Server-to-server callers (webhook runner) pass no values, so manual
  // fields render empty — except those with a default (e.g. date "today").
  // Warn when required fields cannot be satisfied rather than failing.
  const fieldValues = resolveManualFieldValues(template.fields, rawFieldValues);
  const missingRequired = template.fields
    .filter((f) => f.required && fieldValues[f.fieldKey].trim() === '')
    .map((f) => f.label || f.fieldKey);
  if (missingRequired.length > 0) {
    warnings.push(
      `Обязательные поля не заполнены (генерация без значений): ${missingRequired.join(', ')}`,
    );
  }

  /* -------------------------------------------------------------- */
  /* 4) Build the .docx Buffer from the original template           */
  /* -------------------------------------------------------------- */
  // Substitute formula values, manual field values and product rows
  // directly into the admin-uploaded original .docx (no HTML→PDF step),
  // preserving all original Word formatting.
  if (!template.originalDocx || template.originalDocx.length === 0) {
    throw new GenerationError(
      'docx_build_failed',
      `template ${templateId} has no originalDocx`,
    );
  }
  const originalDocx = Buffer.isBuffer(template.originalDocx)
    ? template.originalDocx
    : Buffer.from(template.originalDocx);

  let docxBuffer: Buffer;
  try {
    docxBuffer = await buildDocxFromTemplate(originalDocx, {
      formulas: formulaResults,
      products: context.PRODUCTS ?? [],
      fieldValues,
      title: template.name,
    });
  } catch (err) {
    if (err instanceof DocxTemplateError) {
      throw new GenerationError('docx_build_failed', err.message);
    }
    throw err;
  }

  /* -------------------------------------------------------------- */
  /* 5) disk.storage.getforapp → folder id                          */
  /* -------------------------------------------------------------- */
  let folderId: number;
  try {
    const storage = (await client.callMethod(
      'disk.storage.getforapp',
      {},
    )) as Record<string, unknown>;
    folderId = Number(storage.ROOT_OBJECT_ID ?? storage.ID ?? 0);
    if (!Number.isFinite(folderId) || folderId <= 0) {
      throw new GenerationError(
        'disk_gateway',
        'disk.storage.getforapp returned no ROOT_OBJECT_ID',
      );
    }
  } catch (err) {
    if (err instanceof GenerationError) throw err;
    if (err instanceof B24Error) {
      throw new GenerationError(
        'disk_gateway',
        `disk.storage.getforapp failed: ${err.message}`,
      );
    }
    throw err;
  }

  /* -------------------------------------------------------------- */
  /* 6) disk.folder.uploadfile                                      */
  /* -------------------------------------------------------------- */
  const safeName = template.name.replace(/[^\p{L}\p{N}._\-\s]/gu, '_').trim() || 'template';
  const fileName = `${safeName}_deal${dealId}_${Date.now()}.docx`;

  let uploaded;
  try {
    uploaded = await client.uploadDiskFile(folderId, fileName, docxBuffer);
  } catch (err) {
    if (err instanceof B24Error) {
      throw new GenerationError('upload_failed', `disk.folder.uploadfile failed: ${err.message}`);
    }
    throw err;
  }

  const fileId = Number(uploaded.ID ?? 0);
  const downloadUrl = String(uploaded.DOWNLOAD_URL ?? uploaded.DETAIL_URL ?? '');

  /* -------------------------------------------------------------- */
  /* 7) Optional UF_CRM_* binding                                   */
  /* -------------------------------------------------------------- */
  let binding: BindingResult | null = null;
  const fieldName = effectiveFieldBinding;
  if (fieldName) {
    try {
      let isMultiple = false;
      try {
        const dealFields = await client.getDealFields();
        const meta = dealFields.find((f) => f.code === fieldName);
        isMultiple = Boolean(meta?.isMultiple);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), fieldName },
          'getDealFields failed in generation pipeline; defaulting isMultiple=false',
        );
      }

      // See routes/generate.ts for the full reasoning behind the
      // `crm.item.update` + `useOriginalUfNames:Y` choice. Summary:
      // Bitrix requires the universal item update for file UF fields
      // and the array-merge format below to preserve existing files
      // when the field is multi-valued.
      const newFilePayload: [string, string] = [fileName, docxBuffer.toString('base64')];

      let fieldValue: unknown;
      if (isMultiple) {
        const existingRefs: Array<{ id: number }> = [];
        try {
          const rawDeal = await client.callMethod<Record<string, unknown>>(
            'crm.deal.get',
            { id: dealId },
          );
          const raw = rawDeal?.[fieldName];
          const items = Array.isArray(raw)
            ? raw
            : raw !== null && raw !== undefined && raw !== ''
              ? [raw]
              : [];
          for (const item of items) {
            let id: number | null = null;
            if (typeof item === 'number') {
              id = item;
            } else if (typeof item === 'string') {
              const n = Number(item);
              if (Number.isFinite(n)) id = n;
            } else if (item && typeof item === 'object') {
              const obj = item as Record<string, unknown>;
              const candidate = obj.id ?? obj.ID ?? obj.fileId ?? obj.FILE_ID;
              const n = Number(candidate);
              if (Number.isFinite(n) && n > 0) id = n;
            }
            if (id != null && id > 0) existingRefs.push({ id });
          }
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err), fieldName },
            'crm.deal.get failed while resolving existing file IDs; ' +
              'proceeding with no existing files (may overwrite)',
          );
        }
        fieldValue = [...existingRefs, newFilePayload];
      } else {
        fieldValue = newFilePayload;
      }

      await client.callMethod('crm.item.update', {
        entityTypeId: 2,
        id: dealId,
        fields: { [fieldName]: fieldValue },
        useOriginalUfNames: 'Y',
      });
      binding = { fieldName, ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      binding = { fieldName, ok: false, error: msg };
      warnings.push(`crm.item.update failed for ${fieldName}: ${msg}`);
      logger.warn({ err: msg, fieldName }, 'crm.item.update failed');
    }
  } else {
    warnings.push('dealFieldBinding not configured');
  }

  /* -------------------------------------------------------------- */
  /* 8) Timeline comment (per-theme, with file attachment)          */
  /* -------------------------------------------------------------- */
  let timeline: GenerationResult['timeline'] = { ok: false };
  if (effectiveAddToTimeline) {
    try {
      const commentId = await client.callMethod<number>(
        'crm.timeline.comment.add',
        {
          fields: {
            ENTITY_ID: dealId,
            ENTITY_TYPE: 'deal',
            COMMENT: `Сгенерирован документ: ${template.name}`,
            FILES: [[fileName, docxBuffer.toString('base64')]],
          },
        },
      );
      timeline = { ok: true, commentId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      timeline = { ok: false, error: msg };
      warnings.push(`crm.timeline.comment.add failed: ${msg}`);
      logger.warn({ err: msg }, 'crm.timeline.comment.add failed');
    }
  } else {
    warnings.push('addToTimeline disabled for this theme');
  }

  /* -------------------------------------------------------------- */
  /* 9) Reply                                                       */
  /* -------------------------------------------------------------- */
  return {
    fileId,
    downloadUrl,
    fileName,
    timelineCommentId: timeline.commentId,
    formulas: formulaResults,
    binding,
    timeline,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Manual field value resolution                                       */
/* ------------------------------------------------------------------ */

/** Minimal shape of a TemplateField needed to resolve its value. */
export interface FieldForResolve {
  fieldKey: string;
  type: string;
  defaultValue: string | null;
}

/** Current date as `dd.MM.yyyy` (server local time). */
function todayRu(): string {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

/** Resolve a field's default into a concrete string for substitution. */
function resolveFieldDefault(field: FieldForResolve): string {
  // Date defaults are tokens; the only one supported is "today".
  if (field.type === 'date') {
    return field.defaultValue === 'today' ? todayRu() : '';
  }
  // text/textarea/number defaults are literal values.
  return field.defaultValue ?? '';
}

/**
 * Build the final manual-field value map. A value provided by the
 * caller (even an empty string) is respected as-is; only when the key
 * is ABSENT do we fall back to the field's default. This lets the UI
 * (which always sends every key) override a default by clearing it,
 * while server-to-server callers (webhooks, which send nothing) still
 * get defaults like "today".
 */
export function resolveManualFieldValues(
  fields: FieldForResolve[],
  rawValues: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const provided = rawValues?.[f.fieldKey];
    if (typeof provided === 'string') {
      out[f.fieldKey] = provided;
    } else if (provided != null) {
      out[f.fieldKey] = String(provided);
    } else {
      out[f.fieldKey] = resolveFieldDefault(f);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Product usage detection                                             */
/* ------------------------------------------------------------------ */

/** Regex patterns for product-related helpers in formula expressions. */
const PRODUCT_HELPER_RE = /product(?:Sum|Count|Get|Image)\s*\(/i;
const PRODUCT_IMAGE_HELPER_RE = /productImage\s*\(/i;

/**
 * Scan the template HTML and formula expressions to determine whether
 * product data (and product images) need to be fetched from Bitrix24.
 */
function detectProductUsage(
  contentHtml: string,
  expressions: string[],
): { fetchProducts: boolean; fetchProductImages: boolean } {
  const hasProductTable = contentHtml.includes('data-product-table')
    || contentHtml.includes('data-product-field');
  const hasProductImageAttr = contentHtml.includes('data-product-image');

  let hasProductHelper = false;
  let hasProductImageHelper = false;

  for (const expr of expressions) {
    if (PRODUCT_HELPER_RE.test(expr)) hasProductHelper = true;
    if (PRODUCT_IMAGE_HELPER_RE.test(expr)) hasProductImageHelper = true;
    if (hasProductHelper && hasProductImageHelper) break;
  }

  const fetchProducts = hasProductTable || hasProductHelper;
  const fetchProductImages =
    fetchProducts && (hasProductImageAttr || hasProductImageHelper);

  return { fetchProducts, fetchProductImages };
}
