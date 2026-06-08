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
 * This route is a thin HTTP adapter: it authenticates, performs a
 * strict up-front validation of required manual fields (rejecting the
 * request so the UI can prompt the user) and then delegates the entire
 * generation pipeline to `runGeneration` in `services/generationPipeline`,
 * which is the single source of truth shared with the bizproc-robot and
 * outgoing-webhook entry points. `GenerationError` kinds returned by the
 * pipeline are mapped to Fastify reply helpers (404 / 400 / 502).
 *
 * The generated artifact is a `.docx`: `runGeneration` substitutes
 * formula values, manual `fieldValues` and product rows directly into the
 * admin-uploaded original `.docx` via `buildDocxFromTemplate`.
 *
 * The route is auth-gated by the global B24 middleware. Phase 6
 * (bz3.1) will additionally enforce the admin role.
 */

import type { FastifyInstance } from 'fastify';
import type { GenerateResponse } from '@b24-doc-gen/shared';
import { prisma } from '../prisma/client.js';
import { B24Client } from '../services/b24Client.js';
import {
  runGeneration,
  resolveManualFieldValues,
  GenerationError,
} from '../services/generationPipeline.js';
import type { FormulaEvaluationResult } from '@b24-doc-gen/shared';

/* ------------------------------------------------------------------ */
/* DTOs                                                                */
/* ------------------------------------------------------------------ */

interface GenerateBody {
  templateId?: string;
  dealId?: number | string;
  /** Values for the template's manual fields, keyed by fieldKey. */
  fieldValues?: Record<string, string>;
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
    /* Required manual-field validation (hard fail before generating) */
    /* -------------------------------------------------------------- */
    // The shared pipeline only *warns* about missing required fields so
    // that server-to-server callers (webhooks) never abort. The
    // interactive route is stricter: it rejects the request up-front so
    // the UI can prompt the user to fill them in. We only need the
    // template's `fields` for this check.
    const fieldsOnly = await prisma.template.findUnique({
      where: { id: templateId },
      select: { fields: true },
    });
    if (!fieldsOnly) return reply.notFound(`template ${templateId} not found`);

    const rawFieldValues =
      body.fieldValues && typeof body.fieldValues === 'object'
        ? body.fieldValues
        : undefined;
    const resolvedFields = resolveManualFieldValues(fieldsOnly.fields, rawFieldValues);
    // A required field is satisfied when the user supplied a non-empty raw
    // value OR the resolved value is non-empty. The raw check matters for
    // `select` fields whose chosen option maps to an empty string (mapped
    // mode) — the user did pick something, so we must not reject it, staying
    // consistent with the frontend's "missing required" guard.
    const missingRequired = fieldsOnly.fields
      .filter((f) => {
        if (!f.required) return false;
        const raw = rawFieldValues?.[f.fieldKey];
        const rawFilled = typeof raw === 'string' && raw.trim() !== '';
        const resolvedFilled = (resolvedFields[f.fieldKey] ?? '').trim() !== '';
        return !rawFilled && !resolvedFilled;
      })
      .map((f) => f.label || f.fieldKey);
    if (missingRequired.length > 0) {
      return reply.badRequest(
        `Заполните обязательные поля: ${missingRequired.join(', ')}`,
      );
    }

    const client = new B24Client({
      portal: auth.domain,
      accessToken: auth.accessToken,
    });

    /* -------------------------------------------------------------- */
    /* Delegate the whole pipeline to runGeneration                   */
    /* -------------------------------------------------------------- */
    // runGeneration performs: template load → deal context → formula
    // evaluation → buildDocxFromTemplate (.docx) → disk upload → optional
    // UF_CRM_* binding → optional timeline comment, returning a result
    // whose shape matches GenerateRouteResponse exactly.
    try {
      const result = await runGeneration({
        templateId,
        dealId: dealId as number,
        client,
        logger: request.log,
        fieldValues: rawFieldValues,
      });
      const response: GenerateRouteResponse = result;
      return response;
    } catch (err) {
      if (err instanceof GenerationError) {
        switch (err.kind) {
          case 'template_not_found':
          case 'deal_not_found':
            return reply.notFound(err.message);
          case 'bad_deal_id':
          case 'docx_build_failed':
            return reply.badRequest(err.message);
          case 'deal_gateway':
          case 'disk_gateway':
          case 'upload_failed':
            return reply.badGateway(err.message);
          default:
            throw err;
        }
      }
      throw err;
    }
  });
}
