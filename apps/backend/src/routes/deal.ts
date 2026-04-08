/**
 * REST-proxy endpoints for the Deal entity.
 *
 *  - `GET /api/deal/:id/fields` — returns the field metadata for the
 *    `crm.deal` entity. Cached in memory for 5 minutes per portal.
 *  - `GET /api/deal/:id/data`   — returns the deal record together
 *    with its primary contact and company (one batch call).
 *
 * All routes require authentication (the global `registerAuthMiddleware`
 * preHandler hook in `server.ts` populates `request.b24Auth`). Routes
 * use the per-request `accessToken + portal` from the auth payload to
 * construct an instance of `B24Client`.
 */

import type { FastifyInstance } from 'fastify';
import type { DealField } from '@b24-doc-gen/shared';
import { B24Client, B24Error } from '../services/b24Client.js';
import { TTLCache } from '../services/cache.js';

/** Five minutes — see x0t.4 design notes. */
const DEAL_FIELDS_TTL_MS = 5 * 60 * 1000;

/** Per-portal cache of `crm.deal.fields` responses. */
const dealFieldsCache = new TTLCache<DealField[]>(DEAL_FIELDS_TTL_MS);
/** Per-portal cache of `crm.contact.fields` and `crm.company.fields`. */
const contactFieldsCache = new TTLCache<DealField[]>(DEAL_FIELDS_TTL_MS);
const companyFieldsCache = new TTLCache<DealField[]>(DEAL_FIELDS_TTL_MS);

/** Exported for tests + cache-busting if a UF_CRM field is created. */
export function invalidateDealFieldsCache(portal?: string): void {
  if (portal) {
    dealFieldsCache.delete(portal);
    contactFieldsCache.delete(portal);
    companyFieldsCache.delete(portal);
  } else {
    dealFieldsCache.clear();
    contactFieldsCache.clear();
    companyFieldsCache.clear();
  }
}

interface DealParams {
  id: string;
}

export async function registerDealRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------------------------------------------------------- */
  /* GET /api/deal/:id/fields                                          */
  /* ---------------------------------------------------------------- */
  app.get<{ Params: DealParams }>('/api/deal/:id/fields', async (request, reply) => {
    const auth = request.b24Auth;
    if (!auth) return reply.unauthorized('B24 auth payload missing');

    const cached = dealFieldsCache.get(auth.domain);
    if (cached) {
      return { fields: cached, cached: true };
    }

    const client = new B24Client({
      portal: auth.domain,
      accessToken: auth.accessToken,
    });

    try {
      const fields = await client.getDealFields();
      dealFieldsCache.set(auth.domain, fields);
      return { fields, cached: false };
    } catch (err) {
      throw mapB24Error(err);
    }
  });

  /* ---------------------------------------------------------------- */
  /* GET /api/crm/fields — all three entity schemas in one call        */
  /* ---------------------------------------------------------------- */
  app.get('/api/crm/fields', async (request, reply) => {
    const auth = request.b24Auth;
    if (!auth) return reply.unauthorized('B24 auth payload missing');

    const cachedDeal = dealFieldsCache.get(auth.domain);
    const cachedContact = contactFieldsCache.get(auth.domain);
    const cachedCompany = companyFieldsCache.get(auth.domain);
    if (cachedDeal && cachedContact && cachedCompany) {
      return {
        deal: cachedDeal,
        contact: cachedContact,
        company: cachedCompany,
        cached: true,
      };
    }

    const client = new B24Client({
      portal: auth.domain,
      accessToken: auth.accessToken,
    });

    try {
      const [deal, contact, company] = await Promise.all([
        cachedDeal ? Promise.resolve(cachedDeal) : client.getDealFields(),
        cachedContact ? Promise.resolve(cachedContact) : client.getContactFields(),
        cachedCompany ? Promise.resolve(cachedCompany) : client.getCompanyFields(),
      ]);
      if (!cachedDeal) dealFieldsCache.set(auth.domain, deal);
      if (!cachedContact) contactFieldsCache.set(auth.domain, contact);
      if (!cachedCompany) companyFieldsCache.set(auth.domain, company);
      return { deal, contact, company, cached: false };
    } catch (err) {
      throw mapB24Error(err);
    }
  });

  /* ---------------------------------------------------------------- */
  /* GET /api/deal/:id/data                                            */
  /* ---------------------------------------------------------------- */
  app.get<{ Params: DealParams }>('/api/deal/:id/data', async (request, reply) => {
    const auth = request.b24Auth;
    if (!auth) return reply.unauthorized('B24 auth payload missing');

    const dealId = Number(request.params.id);
    if (!Number.isFinite(dealId) || dealId <= 0) {
      return reply.badRequest('Invalid deal id');
    }

    const client = new B24Client({
      portal: auth.domain,
      accessToken: auth.accessToken,
    });

    try {
      // Step 1 — fetch the deal + its contact/company links via batch.
      const stage1 = await client.callBatch<Record<string, unknown>>({
        deal: { method: 'crm.deal.get', params: { id: dealId } },
        contacts: {
          method: 'crm.deal.contact.items.get',
          params: { id: dealId },
        },
      });

      const errs = stage1.result_error;
      const dealResultRaw = stage1.result.deal as unknown as
        | Record<string, unknown>
        | undefined;
      if (!dealResultRaw || (errs && errs.deal)) {
        throw new B24Error(
          (errs && errs.deal) || 'crm.deal.get returned no result',
          'DEAL_NOT_FOUND',
          404,
        );
      }
      const deal = dealResultRaw;

      const contactsListRaw = stage1.result.contacts as unknown;
      const contactsList = Array.isArray(contactsListRaw)
        ? (contactsListRaw as Array<Record<string, unknown>>)
        : [];

      const primaryContact = pickPrimaryContact(contactsList);
      const primaryContactId = primaryContact
        ? Number(primaryContact['CONTACT_ID'] ?? primaryContact['contact_id'])
        : null;
      const companyId = Number(deal['COMPANY_ID'] ?? 0);

      // Step 2 — load the linked contact + company via a second batch.
      const stage2Calls: Record<string, { method: string; params?: Record<string, unknown> }> = {};
      if (primaryContactId && Number.isFinite(primaryContactId) && primaryContactId > 0) {
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

      let contact: Record<string, unknown> | null = null;
      let company: Record<string, unknown> | null = null;
      if (Object.keys(stage2Calls).length > 0) {
        const stage2 = await client.callBatch<Record<string, unknown>>(stage2Calls);
        contact = (stage2.result.contact as Record<string, unknown> | undefined) ?? null;
        company = (stage2.result.company as Record<string, unknown> | undefined) ?? null;
      }

      return { deal, contact, company };
    } catch (err) {
      throw mapB24Error(err);
    }
  });
}

/**
 * Picks the contact marked as IS_PRIMARY === 'Y'. Falls back to the
 * first contact in the list, or null if there are none.
 */
function pickPrimaryContact(
  list: Array<Record<string, unknown>>,
): Record<string, unknown> | null {
  if (list.length === 0) return null;
  const primary = list.find((c) => String(c['IS_PRIMARY'] ?? '').toUpperCase() === 'Y');
  return primary ?? list[0];
}

/**
 * Translate B24Error into the closest matching Fastify HTTP error so
 * the global error handler renders a sensible JSON envelope.
 */
function mapB24Error(err: unknown): Error {
  if (err instanceof B24Error) {
    const status = err.status > 0 ? err.status : 502;
    const wrapped = new Error(`${err.code}: ${err.message}`);
    (wrapped as Error & { statusCode: number }).statusCode = status;
    return wrapped;
  }
  return err instanceof Error ? err : new Error(String(err));
}
