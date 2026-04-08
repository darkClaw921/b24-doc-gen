/**
 * dealData — server-side aggregation of a CRM deal together with its
 * primary contact and linked company, returned as the flat
 * `FormulaContext` structure consumed by `formulaEngine`.
 *
 * Why this module exists:
 *  - Both the preview endpoint (`GET /api/templates/:id/preview`) and
 *    the generation endpoint (`POST /api/generate`) need the same
 *    batch of deal + contact + company data.
 *  - Phase 4 routed this logic inline in `routes/formulas.ts` and
 *    `routes/deal.ts`. Phase 5 centralizes it here so both paths hit
 *    the exact same Bitrix24 query plan and produce identical scopes.
 *
 * How it works:
 *  1. Stage 1 — a single `batch` call fetches `crm.deal.get` plus
 *     `crm.deal.contact.items.get` so we don't pay two round-trips.
 *  2. From the contacts array we pick the IS_PRIMARY='Y' entry,
 *     falling back to the first item if none is marked primary.
 *  3. Stage 2 — another `batch` call fetches `crm.contact.get` and
 *     `crm.company.get` for whichever of the two ids we have. If
 *     neither id is present we skip stage 2 entirely.
 *  4. The returned object is intentionally flat:
 *       { DEAL: {...}, CONTACT: {...}, COMPANY: {...} }
 *     Each top-level key is a `Record<string, unknown>` — keys are
 *     the raw Bitrix24 field codes (OPPORTUNITY, TITLE, UF_CRM_*,
 *     PHONE, EMAIL, ...). The caller passes this object directly to
 *     `evaluateExpression(expr, context)` from `formulaEngine`.
 *
 * Contact/company normalization:
 *  - Bitrix24 returns multi-value fields (PHONE, EMAIL, WEB, IM) as
 *    arrays of `{ VALUE, VALUE_TYPE, TYPE_ID }`. Accessing
 *    `CONTACT.PHONE` from a formula should just give the first phone
 *    number as a string. We therefore replace any multi-value array
 *    with its first `VALUE` entry (or empty string). Scalars and
 *    UF_CRM_* fields are passed through unchanged.
 *  - Missing contact/company returns an empty object, not null, so
 *    formula accessors like `CONTACT.NAME` resolve to `undefined`
 *    rather than throwing.
 *
 * Public API:
 *  - `getDealContext(client, dealId)` → `Promise<FormulaContext>`
 *  - `DealDataError` thrown when the deal itself cannot be loaded
 *    (404) so callers can distinguish that from an auth failure.
 */

import type { FormulaContext, EntityValues } from '@b24-doc-gen/shared';
import { B24Client, B24Error } from './b24Client.js';

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/**
 * Thrown when the deal record cannot be loaded from Bitrix24. Kept
 * separate from `B24Error` so route handlers can return a clean 404
 * instead of a bad-gateway error.
 */
export class DealDataError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'DealDataError';
    this.code = code;
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Fetch a deal together with its primary contact and linked company,
 * then return the flat `FormulaContext` shape used by the mathjs
 * sandbox.
 *
 * The function performs at most two Bitrix24 `batch` calls:
 *
 *   - Stage 1: `crm.deal.get` + `crm.deal.contact.items.get`
 *   - Stage 2 (conditional): `crm.contact.get` + `crm.company.get`
 *
 * Throws `DealDataError` if the deal itself is missing or the upstream
 * returns an error for the `deal` slot. Missing contact/company is
 * treated as "not attached" and returns an empty object for that key.
 */
export async function getDealContext(
  client: B24Client,
  dealId: number | string,
): Promise<FormulaContext> {
  const dealIdNum = typeof dealId === 'string' ? Number(dealId) : dealId;
  if (!Number.isFinite(dealIdNum) || dealIdNum <= 0) {
    throw new DealDataError(
      `Invalid dealId: ${String(dealId)}`,
      'INVALID_DEAL_ID',
      400,
    );
  }

  /* -------------------------------------------------------------- */
  /* Stage 1 — deal + contact list in one batch                     */
  /* -------------------------------------------------------------- */
  let stage1;
  try {
    stage1 = await client.callBatch<Record<string, unknown>>({
      deal: { method: 'crm.deal.get', params: { id: dealIdNum } },
      contacts: {
        method: 'crm.deal.contact.items.get',
        params: { id: dealIdNum },
      },
    });
  } catch (err) {
    if (err instanceof B24Error) {
      throw new DealDataError(
        `Failed to fetch deal ${dealIdNum}: ${err.message}`,
        err.code,
        err.status || 502,
      );
    }
    throw err;
  }

  // The batch envelope returns per-call errors under result_error.
  if (stage1.result_error?.deal) {
    throw new DealDataError(
      stage1.result_error.deal,
      'DEAL_NOT_FOUND',
      404,
    );
  }
  const dealRaw = stage1.result.deal as Record<string, unknown> | undefined;
  if (!dealRaw || typeof dealRaw !== 'object') {
    throw new DealDataError(
      `Deal ${dealIdNum} not found`,
      'DEAL_NOT_FOUND',
      404,
    );
  }

  const contactsRaw = stage1.result.contacts as unknown;
  const contactList = Array.isArray(contactsRaw)
    ? (contactsRaw as Array<Record<string, unknown>>)
    : [];

  // Prefer IS_PRIMARY='Y'; otherwise take the first entry.
  const primary =
    contactList.find(
      (c) => String(c['IS_PRIMARY'] ?? '').toUpperCase() === 'Y',
    ) ?? contactList[0];

  const primaryContactId = primary
    ? Number(primary['CONTACT_ID'] ?? primary['contact_id'] ?? 0)
    : 0;
  const companyId = Number(dealRaw['COMPANY_ID'] ?? 0);

  /* -------------------------------------------------------------- */
  /* Stage 2 — contact + company in one batch (conditional)         */
  /* -------------------------------------------------------------- */
  const stage2Calls: Record<
    string,
    { method: string; params?: Record<string, unknown> }
  > = {};
  if (Number.isFinite(primaryContactId) && primaryContactId > 0) {
    stage2Calls.contact = {
      method: 'crm.contact.get',
      params: { id: primaryContactId },
    };
  }
  if (Number.isFinite(companyId) && companyId > 0) {
    stage2Calls.company = {
      method: 'crm.company.get',
      params: { id: companyId },
    };
  }

  let contactRaw: Record<string, unknown> = {};
  let companyRaw: Record<string, unknown> = {};

  if (Object.keys(stage2Calls).length > 0) {
    try {
      const stage2 = await client.callBatch<Record<string, unknown>>(stage2Calls);
      if (stage2.result.contact && !stage2.result_error?.contact) {
        contactRaw = (stage2.result.contact as Record<string, unknown>) ?? {};
      }
      if (stage2.result.company && !stage2.result_error?.company) {
        companyRaw = (stage2.result.company as Record<string, unknown>) ?? {};
      }
    } catch (err) {
      // Non-fatal: a missing contact or company should not break
      // the whole preview. We log the reason via the error message
      // but return empty entity objects so the formula can still
      // evaluate DEAL-only expressions.
      if (!(err instanceof B24Error)) throw err;
    }
  }

  return {
    DEAL: flattenEntity(dealRaw),
    CONTACT: flattenEntity(contactRaw),
    COMPANY: flattenEntity(companyRaw),
  };
}

/* ------------------------------------------------------------------ */
/* Normalization                                                       */
/* ------------------------------------------------------------------ */

/**
 * Flatten a raw Bitrix24 entity record so multi-value fields become
 * simple scalars and the result plays well with the mathjs expression
 * engine.
 *
 *  - `PHONE: [{ VALUE: '+1' }, ...]` → `PHONE: '+1'`
 *  - `EMAIL`/`WEB`/`IM` follow the same rule.
 *  - Arrays of primitives keep their first element (`[ '1', '2' ]` → `'1'`).
 *  - Arrays of plain objects without `VALUE` are left as-is because
 *    the caller may want to reach into specific keys via mathjs.
 *  - Null/undefined values are skipped — the key is still present on
 *    the returned object so accessors don't throw.
 */
function flattenEntity(entity: Record<string, unknown>): EntityValues {
  const out: EntityValues = {};
  for (const [key, value] of Object.entries(entity)) {
    out[key] = flattenValue(value);
  }
  return out;
}

/** Flatten a single field value. See `flattenEntity` for the rules. */
function flattenValue(value: unknown): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return '';
    const first = value[0];
    if (first && typeof first === 'object' && 'VALUE' in (first as object)) {
      // Shape: [{ VALUE, VALUE_TYPE, TYPE_ID, ID }]. Take VALUE.
      const raw = (first as { VALUE?: unknown }).VALUE;
      return typeof raw === 'string' || typeof raw === 'number' ? raw : '';
    }
    return first;
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Lightweight self-test (used by tests, not executed in prod)        */
/* ------------------------------------------------------------------ */

/**
 * Small helper that tests can use instead of spinning up a real
 * B24Client. Exposed so `__tests__/dealData.test.ts` (Phase 6) can
 * exercise the shape normalization without touching the network.
 */
export const __internal = {
  flattenEntity,
  flattenValue,
};
