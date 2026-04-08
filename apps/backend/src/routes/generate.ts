/**
 * Generate routes — produce a `.docx` file from a saved template,
 * upload it to the application's Bitrix24 disk folder and (when
 * configured) attach it to the deal + post a timeline comment.
 *
 * Public endpoint:
 *   POST /api/generate
 *   body: { templateId: string, dealId: number }
 *   returns: { fileId, downloadUrl, fieldUpdated, timelineCommentId? }
 *
 * Pipeline (each step short-circuits with a structured error):
 *   1. Load the template + formulas from Prisma.
 *   2. Build the deal context via `getDealContext` (single source of
 *      truth shared with `GET /api/templates/:id/preview`).
 *   3. Evaluate every formula and capture the per-tag result map so
 *      `docxBuilder` can inline the values into the .docx.
 *   4. `buildDocxFromHtml(template.contentHtml, { formulas })`
 *      yields a Node Buffer.
 *   5. `disk.storage.getforapp` returns the application's storage
 *      root. We use `ROOT_OBJECT_ID` as the target folder for the
 *      upload.
 *   6. `disk.folder.uploadfile` (via `B24Client.uploadDiskFile`)
 *      stores the .docx and returns the disk file metadata
 *      (`ID`, `DOWNLOAD_URL`, ...).
 *   7. If `AppSettings.dealFieldBinding` is set, `crm.deal.update`
 *      is called with `{ [UF_CRM_*]: fileId }` so the file shows up
 *      in the deal card. Failures here are non-fatal — we still
 *      return the upload result and report the error in the response.
 *   8. `crm.timeline.comment.add` posts a "Сгенерирован документ"
 *      comment with the download URL. Also non-fatal.
 *
 * The route is auth-gated by the global B24 middleware. Phase 6
 * (bz3.1) will additionally enforce the admin role.
 */

import type { FastifyInstance } from 'fastify';
import type { GenerateResponse } from '@b24-doc-gen/shared';
import { prisma } from '../prisma/client.js';
import { B24Client, B24Error } from '../services/b24Client.js';
import { getDealContext, DealDataError } from '../services/dealData.js';
import { evaluateExpression } from '../services/formulaEngine.js';
import { buildDocxFromHtml, DocxBuildError } from '../services/docxBuilder.js';
import { toAppSettings } from './install.js';
import type { FormulaEvaluationResult } from '@b24-doc-gen/shared';

/* ------------------------------------------------------------------ */
/* DTOs                                                                */
/* ------------------------------------------------------------------ */

interface GenerateBody {
  templateId?: string;
  dealId?: number | string;
}

/**
 * Result of the deal-binding step. Reported in the response so the
 * frontend can show a yellow warning when the binding step failed
 * but the file still uploaded successfully.
 */
interface BindingResult {
  fieldName: string;
  ok: boolean;
  error?: string;
}

interface GenerateRouteResponse extends GenerateResponse {
  /** Computed file name as it appears in disk. */
  fileName: string;
  /** Per-formula evaluation map (so the UI can show what was used). */
  formulas: Record<string, FormulaEvaluationResult>;
  /** Result of the optional UF_CRM_* attach step (if a binding is set). */
  binding: BindingResult | null;
  /** Result of the timeline comment step. */
  timeline: { ok: boolean; commentId?: number; error?: string };
  /** Non-fatal notices (e.g. "dealFieldBinding not configured"). */
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* Route registration                                                  */
/* ------------------------------------------------------------------ */

export async function registerGenerateRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: GenerateBody }>('/api/generate', async (request, reply) => {
    const auth = request.b24Auth;
    if (!auth) return reply.unauthorized('B24 auth payload missing');
    if (!auth.accessToken) {
      return reply.unauthorized('Missing access token in B24 auth payload');
    }

    const body = request.body ?? ({} as GenerateBody);
    const templateId = typeof body.templateId === 'string' ? body.templateId : '';
    const dealIdRaw = body.dealId;
    const dealId = typeof dealIdRaw === 'string' ? Number(dealIdRaw) : dealIdRaw;

    if (!templateId) {
      return reply.badRequest('templateId is required');
    }
    if (!Number.isFinite(dealId) || (dealId as number) <= 0) {
      return reply.badRequest('dealId must be a positive number');
    }

    /* -------------------------------------------------------------- */
    /* 1) Load the template + formulas                                */
    /* -------------------------------------------------------------- */
    const template = await prisma.template.findUnique({
      where: { id: templateId },
      include: { formulas: true, theme: true },
    });
    if (!template) return reply.notFound(`template ${templateId} not found`);

    const settingsRow = await prisma.appSettings.findUnique({ where: { id: 1 } });
    const settings = settingsRow ? toAppSettings(settingsRow) : null;

    // Effective per-template generation settings: theme overrides win.
    // dealFieldBinding falls back to AppSettings only when the theme has
    // no per-folder override; addToTimeline is always taken from the theme.
    const effectiveFieldBinding =
      template.theme.dealFieldBinding ?? settings?.dealFieldBinding ?? null;
    const effectiveAddToTimeline = template.theme.addToTimeline;

    const client = new B24Client({
      portal: auth.domain,
      accessToken: auth.accessToken,
    });

    /* -------------------------------------------------------------- */
    /* 2) Build deal context                                          */
    /* -------------------------------------------------------------- */
    let context;
    try {
      context = await getDealContext(client, dealId as number);
    } catch (err) {
      if (err instanceof DealDataError) {
        if (err.status === 404) return reply.notFound(err.message);
        if (err.status === 400) return reply.badRequest(err.message);
        return reply.badGateway(err.message);
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
        return reply.badRequest(`Failed to build .docx: ${err.message}`);
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
        return reply.badGateway('disk.storage.getforapp returned no ROOT_OBJECT_ID');
      }
    } catch (err) {
      if (err instanceof B24Error) {
        return reply.badGateway(`disk.storage.getforapp failed: ${err.message}`);
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
        return reply.badGateway(`disk.folder.uploadfile failed: ${err.message}`);
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
        // Detect whether the binding field is multi-valued from the
        // live deal field schema. We need this because the request
        // shape differs (single = one tuple, multiple = array).
        let isMultiple = false;
        try {
          const dealFields = await client.getDealFields();
          const meta = dealFields.find((f) => f.code === fieldName);
          isMultiple = Boolean(meta?.isMultiple);
        } catch (err) {
          request.log.warn(
            { err: err instanceof Error ? err.message : String(err), fieldName },
            'getDealFields failed in generate; defaulting isMultiple=false',
          );
        }

        // IMPORTANT: per the Bitrix24 docs we must NOT use
        // `crm.deal.update` for file UF fields — the recommended
        // method is the universal `crm.item.update` with
        // `entityTypeId: 2` (deal). It is the only path that reliably
        // accepts the merge format below.
        // See: https://apidocs.bitrix24.ru/api-reference/files/how-to-update-files.html
        //
        // Format for the file field value:
        //   - new file:       [filename, base64Content]    (bare tuple)
        //   - existing file:  { id: <numericId> }          (object)
        // The whole field value is an array; any existing file NOT
        // present in that array gets deleted by Bitrix. So when
        // appending we must enumerate every existing file id.
        //
        // We pass `useOriginalUfNames: 'Y'` so we can keep referring
        // to the field by its original SHOUTY name (UF_CRM_TEST2)
        // instead of the camelCase form (ufCrm_TEST2) — keeps the
        // settings/template config consistent.
        const newFilePayload: [string, string] = [
          fileName,
          docxBuffer.toString('base64'),
        ];

        let fieldValue: unknown;
        if (isMultiple) {
          // Refetch the raw deal record so we see the full array of
          // existing files. We can't read this from the formula
          // `context.DEAL` because `flattenEntity`/`flattenValue` in
          // dealData.ts collapses every array to its first element —
          // for a multi-file UF that would lose every file but the
          // first, and Bitrix would silently delete them on update.
          //
          // Bitrix may return existing files as bare numeric IDs,
          // numeric strings, or `{ id, urlMachine, ... }` objects.
          // We normalise to `{ id: <number> }` for the update.
          const existingRefs: Array<{ id: number }> = [];
          try {
            const rawDeal = await client.callMethod<Record<string, unknown>>(
              'crm.deal.get',
              { id: dealId as number },
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
            request.log.warn(
              { err: err instanceof Error ? err.message : String(err), fieldName },
              'crm.deal.get failed while resolving existing file IDs; ' +
                'proceeding with no existing files (may overwrite)',
            );
          }
          fieldValue = [...existingRefs, newFilePayload];
        } else {
          // For a single file field Bitrix accepts the bare tuple.
          fieldValue = newFilePayload;
        }

        await client.callMethod('crm.item.update', {
          entityTypeId: 2,
          id: dealId as number,
          fields: { [fieldName]: fieldValue },
          useOriginalUfNames: 'Y',
        });
        binding = { fieldName, ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        binding = { fieldName, ok: false, error: msg };
        warnings.push(`crm.item.update failed for ${fieldName}: ${msg}`);
        request.log.warn({ err: msg, fieldName }, 'crm.item.update failed');
      }
    } else {
      warnings.push('dealFieldBinding not configured');
    }

    /* -------------------------------------------------------------- */
    /* 8) Timeline comment (per-theme, with file attachment)          */
    /* -------------------------------------------------------------- */
    let timeline: GenerateRouteResponse['timeline'] = { ok: false };
    if (effectiveAddToTimeline) {
      try {
        // The file is attached via FILES, so the comment text itself
        // should NOT include the download URL — the attachment block
        // already gives the user a clickable link, and duplicating it
        // in the body just adds noise.
        const commentId = await client.callMethod<number>(
          'crm.timeline.comment.add',
          {
            fields: {
              ENTITY_ID: dealId as number,
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
        request.log.warn({ err: msg }, 'crm.timeline.comment.add failed');
      }
    } else {
      warnings.push('addToTimeline disabled for this theme');
    }

    /* -------------------------------------------------------------- */
    /* 9) Reply                                                       */
    /* -------------------------------------------------------------- */
    const response: GenerateRouteResponse = {
      fileId,
      downloadUrl,
      fileName,
      timelineCommentId: timeline.commentId,
      formulas: formulaResults,
      binding,
      timeline,
      warnings,
    };
    return response;
  });
}
