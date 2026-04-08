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
 *   5. `buildDocxFromHtml` → Node Buffer.
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
import { buildDocxFromHtml, DocxBuildError } from './docxBuilder.js';
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
  const { templateId, dealId, client, logger } = params;

  /* -------------------------------------------------------------- */
  /* 1) Load the template + formulas                                */
  /* -------------------------------------------------------------- */
  const template = await prisma.template.findUnique({
    where: { id: templateId },
    include: { formulas: true, theme: true },
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
  /* 2) Build deal context                                          */
  /* -------------------------------------------------------------- */
  let context;
  try {
    context = await getDealContext(client, dealId);
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

  /* -------------------------------------------------------------- */
  /* 4) Build the .docx Buffer                                      */
  /* -------------------------------------------------------------- */
  let docxBuffer: Buffer;
  try {
    docxBuffer = await buildDocxFromHtml(template.contentHtml, {
      formulas: formulaResults,
      title: template.name,
    });
  } catch (err) {
    if (err instanceof DocxBuildError) {
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
  const warnings: string[] = [];
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
