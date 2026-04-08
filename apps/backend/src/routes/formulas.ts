/**
 * Formula routes — server-side validation and live evaluation of
 * mathjs-based template formulas.
 *
 *  - `POST /api/formulas/validate` — body `{ expression }`. Parses the
 *      expression in the sandboxed engine and returns either
 *      `{ valid: true, dependencies: { deal, contact, company } }` or
 *      `{ valid: false, error }`. Used by the FormulaBuilder UI for
 *      live feedback while typing.
 *
 *  - `POST /api/formulas/evaluate` — body `{ expression, dealId? }`.
 *      Builds a runtime context by fetching the deal, primary contact
 *      and linked company via `B24Client`, evaluates the expression
 *      and returns `{ value, raw, error?, dependencies }`. The
 *      `dealId` is optional — when omitted the expression is evaluated
 *      against an empty context, which is useful for the builder
 *      preview pane when no deal is selected.
 *
 * Both routes are auth-gated by the global B24 middleware (which
 * populates `request.b24Auth`). The dealData collection here uses the
 * same two-step batch flow as `routes/deal.ts::GET /api/deal/:id/data`
 * — Phase 5 will refactor this into a shared `services/dealData.ts`.
 */

import type { FastifyInstance } from 'fastify';
import type { FormulaContext } from '@b24-doc-gen/shared';
import { validateExpression, evaluateExpression } from '../services/formulaEngine.js';
import { B24Client, B24Error } from '../services/b24Client.js';

/* ------------------------------------------------------------------ */
/* Request / response shapes                                           */
/* ------------------------------------------------------------------ */

interface ValidateBody {
  expression?: string;
}

interface EvaluateBody {
  expression?: string;
  dealId?: number | string;
  /**
   * Optional inline context for cases where the caller already has
   * the entity values (e.g. unit tests, builder preview with sample
   * data). When provided, the route skips the REST round-trip.
   */
  context?: Partial<FormulaContext>;
}

/* ------------------------------------------------------------------ */
/* Route registration                                                  */
/* ------------------------------------------------------------------ */

export async function registerFormulaRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------------------------------------------------------- */
  /* POST /api/formulas/validate                                       */
  /* ---------------------------------------------------------------- */
  app.post<{ Body: ValidateBody }>('/api/formulas/validate', async (request, reply) => {
    const auth = request.b24Auth;
    if (!auth) return reply.unauthorized('B24 auth payload missing');

    const expression = typeof request.body?.expression === 'string'
      ? request.body.expression
      : '';
    if (!expression.trim()) {
      return reply.badRequest('expression is required');
    }

    const result = validateExpression(expression);
    if (!result.ok) {
      return {
        valid: false,
        error: result.error ?? 'Invalid expression',
        dependencies: { deal: [], contact: [], company: [] },
      };
    }
    return {
      valid: true,
      dependencies: result.deps ?? { deal: [], contact: [], company: [] },
    };
  });

  /* ---------------------------------------------------------------- */
  /* POST /api/formulas/evaluate                                       */
  /* ---------------------------------------------------------------- */
  app.post<{ Body: EvaluateBody }>('/api/formulas/evaluate', async (request, reply) => {
    const auth = request.b24Auth;
    if (!auth) return reply.unauthorized('B24 auth payload missing');

    const expression = typeof request.body?.expression === 'string'
      ? request.body.expression
      : '';
    if (!expression.trim()) {
      return reply.badRequest('expression is required');
    }

    // 1) Static validation first — short-circuit on a parse error so
    //    we don't waste a REST call on a broken formula.
    const validation = validateExpression(expression);
    if (!validation.ok) {
      return {
        ok: false,
        value: '',
        raw: null,
        error: validation.error ?? 'Invalid expression',
        dependencies: { deal: [], contact: [], company: [] },
      };
    }

    // 2) Build the runtime context. Three sources, in this order:
    //    - explicit `context` from the request body (used by tests)
    //    - the deal id (loads the deal + primary contact + company)
    //    - empty context (preview without a deal)
    let context: Partial<FormulaContext> = request.body?.context ?? {};
    const dealIdRaw = request.body?.dealId;
    const dealId = typeof dealIdRaw === 'string' ? Number(dealIdRaw) : dealIdRaw;

    if (Number.isFinite(dealId) && (dealId as number) > 0) {
      if (!auth.accessToken) {
        return reply.unauthorized('Missing access token in B24 auth payload');
      }
      try {
        const fetched = await fetchDealContext(
          new B24Client({ portal: auth.domain, accessToken: auth.accessToken }),
          dealId as number,
        );
        // Inline context overrides REST values where keys overlap.
        context = {
          DEAL: { ...fetched.DEAL, ...(context.DEAL ?? {}) },
          CONTACT: { ...fetched.CONTACT, ...(context.CONTACT ?? {}) },
          COMPANY: { ...fetched.COMPANY, ...(context.COMPANY ?? {}) },
        };
      } catch (err) {
        const message = err instanceof B24Error ? err.message : (err as Error).message;
        return reply.badGateway(`Failed to load deal: ${message}`);
      }
    }

    // 3) Evaluate.
    const result = evaluateExpression(expression, context);
    return {
      ok: result.error == null,
      value: result.value,
      raw: result.raw,
      error: result.error,
      dependencies: validation.deps ?? { deal: [], contact: [], company: [] },
    };
  });
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Two-step batch fetch of a deal + its primary contact + its linked
 * company. Mirrors `routes/deal.ts::GET /api/deal/:id/data` so the
 * preview pane sees the exact same shape as the production
 * generation pipeline. Phase 5 will replace this with a shared
 * `services/dealData.ts`.
 */
async function fetchDealContext(
  client: B24Client,
  dealId: number,
): Promise<FormulaContext> {
  const stage1 = await client.callBatch<Record<string, unknown>>({
    deal: { method: 'crm.deal.get', params: { id: dealId } },
    contacts: {
      method: 'crm.deal.contact.items.get',
      params: { id: dealId },
    },
  });

  const dealResult = stage1.result.deal as Record<string, unknown> | undefined;
  if (!dealResult || stage1.result_error?.deal) {
    throw new B24Error(
      stage1.result_error?.deal ?? `Deal ${dealId} not found`,
      'DEAL_NOT_FOUND',
      404,
    );
  }

  const contactsRaw = stage1.result.contacts as unknown;
  const contactList = Array.isArray(contactsRaw)
    ? (contactsRaw as Array<Record<string, unknown>>)
    : [];
  const primary =
    contactList.find((c) => String(c['IS_PRIMARY'] ?? '').toUpperCase() === 'Y') ??
    contactList[0];

  const primaryContactId = primary
    ? Number(primary['CONTACT_ID'] ?? primary['contact_id'])
    : null;
  const companyId = Number(dealResult['COMPANY_ID'] ?? 0);

  const stage2Calls: Record<string, { method: string; params?: Record<string, unknown> }> = {};
  if (primaryContactId && Number.isFinite(primaryContactId) && primaryContactId > 0) {
    stage2Calls.contact = { method: 'crm.contact.get', params: { id: primaryContactId } };
  }
  if (Number.isFinite(companyId) && companyId > 0) {
    stage2Calls.company = { method: 'crm.company.get', params: { id: companyId } };
  }

  let contact: Record<string, unknown> = {};
  let company: Record<string, unknown> = {};
  if (Object.keys(stage2Calls).length > 0) {
    const stage2 = await client.callBatch<Record<string, unknown>>(stage2Calls);
    contact = (stage2.result.contact as Record<string, unknown> | undefined) ?? {};
    company = (stage2.result.company as Record<string, unknown> | undefined) ?? {};
  }

  return {
    DEAL: dealResult,
    CONTACT: contact,
    COMPANY: company,
  };
}
