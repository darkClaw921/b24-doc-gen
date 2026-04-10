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

import type { FormulaContext, EntityValues, ProductRow } from '@b24-doc-gen/shared';
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

/** Options that control which additional data getDealContext loads. */
export interface GetDealContextOptions {
  /** When true, load product rows via `crm.deal.productrows.get`. */
  fetchProducts?: boolean;
  /**
   * When true (and `fetchProducts` is also true), download product
   * images from `catalog.productImage.list` and encode them as
   * base64 data URIs on each `ProductRow`.
   */
  fetchProductImages?: boolean;
}

/**
 * Fetch a deal together with its primary contact and linked company,
 * then return the flat `FormulaContext` shape used by the mathjs
 * sandbox.
 *
 * The function performs at most two Bitrix24 `batch` calls:
 *
 *   - Stage 1: `crm.deal.get` + `crm.deal.contact.items.get`
 *     (+ `crm.deal.productrows.get` when `fetchProducts` is true)
 *   - Stage 2 (conditional): `crm.contact.get` + `crm.company.get`
 *   - Stage 3 (conditional): product image download when
 *     `fetchProductImages` is true
 *
 * Throws `DealDataError` if the deal itself is missing or the upstream
 * returns an error for the `deal` slot. Missing contact/company is
 * treated as "not attached" and returns an empty object for that key.
 */
export async function getDealContext(
  client: B24Client,
  dealId: number | string,
  options: GetDealContextOptions = {},
): Promise<FormulaContext> {
  const dealIdNum = typeof dealId === 'string' ? Number(dealId) : dealId;
  if (!Number.isFinite(dealIdNum) || dealIdNum <= 0) {
    throw new DealDataError(
      `Invalid dealId: ${String(dealId)}`,
      'INVALID_DEAL_ID',
      400,
    );
  }

  const { fetchProducts = false, fetchProductImages = false } = options;

  /* -------------------------------------------------------------- */
  /* Stage 1 — deal + contact list (+ product rows) in one batch    */
  /* -------------------------------------------------------------- */
  const stage1Calls: Record<string, { method: string; params?: Record<string, unknown> }> = {
    deal: { method: 'crm.deal.get', params: { id: dealIdNum } },
    contacts: {
      method: 'crm.deal.contact.items.get',
      params: { id: dealIdNum },
    },
  };
  if (fetchProducts) {
    stage1Calls.productrows = {
      method: 'crm.deal.productrows.get',
      params: { id: dealIdNum },
    };
  }

  let stage1;
  try {
    stage1 = await client.callBatch<Record<string, unknown>>(stage1Calls);
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

  /* -------------------------------------------------------------- */
  /* Stage 3 — product rows + images (conditional)                  */
  /* -------------------------------------------------------------- */
  let products: ProductRow[] = [];
  if (fetchProducts) {
    const rawRows = stage1.result.productrows as unknown;
    console.log('[dealData] fetchProducts=true, rawRows type:', typeof rawRows, 'isArray:', Array.isArray(rawRows));
    if (Array.isArray(rawRows)) {
      console.log('[dealData] rawRows count:', rawRows.length);
      if (rawRows.length > 0) {
        console.log('[dealData] rawRows[0] keys:', Object.keys(rawRows[0] as object));
        console.log('[dealData] rawRows[0] PRODUCT_ID:', (rawRows[0] as Record<string, unknown>).PRODUCT_ID);
      }
      products = (rawRows as Array<Record<string, unknown>>).map(normalizeProductRow);
    } else {
      console.log('[dealData] rawRows not array, fallback to getDealProductRows');
      try {
        products = await client.getDealProductRows(dealIdNum);
      } catch (err) {
        console.log('[dealData] getDealProductRows error:', err instanceof Error ? err.message : String(err));
      }
    }

    console.log('[dealData] products count:', products.length);
    if (products.length > 0) {
      console.log('[dealData] products[0]:', JSON.stringify(products[0]));
    }
    console.log('[dealData] fetchProductImages:', fetchProductImages);

    if (fetchProductImages && products.length > 0) {
      console.log('[dealData] calling attachProductImages...');
      await attachProductImages(client, products);
      console.log('[dealData] after attachProductImages, products[0] image fields:',
        JSON.stringify({
          PREVIEW_PICTURE_BASE64: products[0].PREVIEW_PICTURE_BASE64 ? `${products[0].PREVIEW_PICTURE_BASE64.substring(0, 50)}...` : undefined,
          DETAIL_PICTURE_BASE64: products[0].DETAIL_PICTURE_BASE64 ? `${products[0].DETAIL_PICTURE_BASE64.substring(0, 50)}...` : undefined,
          MORE_PHOTO_BASE64: products[0].MORE_PHOTO_BASE64?.length ?? 0,
        }),
      );
    }
  }

  return {
    DEAL: flattenEntity(dealRaw),
    CONTACT: flattenEntity(contactRaw),
    COMPANY: flattenEntity(companyRaw),
    PRODUCTS: products,
  };
}

/* ------------------------------------------------------------------ */
/* Product row helpers                                                 */
/* ------------------------------------------------------------------ */

/** Max number of concurrent image downloads to avoid overwhelming B24. */
const IMAGE_CONCURRENCY = 5;

/**
 * Coerce a raw product-row record from the batch response into the
 * typed `ProductRow` shape.
 */
function normalizeProductRow(raw: Record<string, unknown>): ProductRow {
  return {
    ID: Number(raw.ID ?? 0),
    PRODUCT_ID: Number(raw.PRODUCT_ID ?? 0),
    PRODUCT_NAME: String(raw.PRODUCT_NAME ?? ''),
    PRICE: Number(raw.PRICE ?? 0),
    QUANTITY: Number(raw.QUANTITY ?? 0),
    DISCOUNT_SUM: Number(raw.DISCOUNT_SUM ?? 0),
    TAX_RATE: Number(raw.TAX_RATE ?? 0),
    SUM: Number(raw.SUM ?? 0),
    MEASURE_NAME: String(raw.MEASURE_NAME ?? ''),
    SORT: Number(raw.SORT ?? 0),
  };
}

/**
 * For each product row with a non-zero PRODUCT_ID, fetch the catalog
 * product data via `catalog.product.get` to extract image URLs
 * (PREVIEW_PICTURE, DETAIL_PICTURE, MORE_PHOTO), then download them
 * as base64. Downloads are batched with a concurrency limit.
 *
 * Strategy: `catalog.product.get` returns image fields as objects with
 * a direct `src`/`url` that can be fetched without signed tokens
 * (unlike `catalog.productImage.list` download URLs which are
 * session-bound and expire quickly).
 */
async function attachProductImages(
  client: B24Client,
  products: ProductRow[],
): Promise<void> {
  const idToRows = new Map<number, ProductRow[]>();
  for (const row of products) {
    if (row.PRODUCT_ID <= 0) continue;
    const existing = idToRows.get(row.PRODUCT_ID);
    if (existing) existing.push(row);
    else idToRows.set(row.PRODUCT_ID, [row]);
  }
  console.log('[attachProductImages] unique product IDs:', Array.from(idToRows.keys()));
  if (idToRows.size === 0) return;

  const entries = Array.from(idToRows.entries());
  for (let i = 0; i < entries.length; i += IMAGE_CONCURRENCY) {
    const chunk = entries.slice(i, i + IMAGE_CONCURRENCY);
    await Promise.all(
      chunk.map(async ([productId, rows]) => {
        console.log(`[attachProductImages] catalog.product.get for productId=${productId}...`);
        let catalogProduct: Record<string, unknown> | null = null;
        try {
          const envelope = await client.callMethod<{
            product?: Record<string, unknown>;
          }>('catalog.product.get', { id: productId });
          catalogProduct = envelope?.product ?? null;
        } catch (err) {
          console.log(`[attachProductImages] catalog.product.get error:`, err instanceof Error ? err.message : String(err));
          return;
        }
        if (!catalogProduct) {
          console.log(`[attachProductImages] no product data for ${productId}`);
          return;
        }

        console.log(`[attachProductImages] product keys:`, Object.keys(catalogProduct).filter(k =>
          /picture|photo|image|preview|detail/i.test(k),
        ));

        // Log raw values of image fields
        const rawPreview = catalogProduct.previewPicture ?? catalogProduct.PREVIEW_PICTURE;
        const rawDetail = catalogProduct.detailPicture ?? catalogProduct.DETAIL_PICTURE;
        console.log(`[attachProductImages] raw previewPicture:`, JSON.stringify(rawPreview));
        console.log(`[attachProductImages] raw detailPicture:`, JSON.stringify(rawDetail));

        // Extract image URLs from the catalog product fields.
        const previewUrl = extractImageUrl(rawPreview);
        const detailUrl = extractImageUrl(rawDetail);

        console.log(`[attachProductImages] previewUrl=${previewUrl?.substring(0, 80) ?? 'null'}`);
        console.log(`[attachProductImages] detailUrl=${detailUrl?.substring(0, 80) ?? 'null'}`);

        // MORE_PHOTO is a product property, not a direct field.
        // Use catalog.productImage.list and try detailUrl → downloadUrl.
        const morePhotoUrls: string[] = [];
        try {
          const images = await client.getProductImages(productId);
          console.log(`[attachProductImages] productImage.list raw:`, JSON.stringify(images.map(i => ({ ...i, raw: undefined }))));
          console.log(`[attachProductImages] productImage.list raw fields:`, images.length > 0 ? JSON.stringify(images[0].raw) : 'empty');
          for (const img of images) {
            // Prefer detailUrl (direct file link) over downloadUrl (signed token, may 404)
            const url = img.detailUrl || img.downloadUrl;
            if (url) morePhotoUrls.push(url);
          }
        } catch (err) {
          console.log(`[attachProductImages] productImage.list error:`, err instanceof Error ? err.message : String(err));
        }

        // If no URLs from productImage.list, check for MORE_PHOTO property
        const morePhotoRaw = catalogProduct.MORE_PHOTO ?? catalogProduct.morePhoto ?? catalogProduct.property258 ?? null;
        console.log(`[attachProductImages] raw MORE_PHOTO:`, JSON.stringify(morePhotoRaw)?.substring(0, 300));
        if (Array.isArray(morePhotoRaw)) {
          for (const item of morePhotoRaw.slice(0, 10)) {
            const u = extractImageUrl(item);
            if (u) morePhotoUrls.push(u);
          }
        }
        console.log(`[attachProductImages] morePhotoUrls count: ${morePhotoUrls.length}`);

        // Download all images in parallel
        const [previewBase64, detailBase64, moreResults] = await Promise.all([
          previewUrl ? client.downloadFileAsBase64(previewUrl) : Promise.resolve(''),
          detailUrl ? client.downloadFileAsBase64(detailUrl) : Promise.resolve(''),
          Promise.all(
            morePhotoUrls.map(async (u) => {
              const b = await client.downloadFileAsBase64(u);
              return { base64: b, url: u };
            }),
          ),
        ]);

        for (const row of rows) {
          if (previewBase64) {
            row.PREVIEW_PICTURE_BASE64 = previewBase64;
            row.PREVIEW_PICTURE_URL = previewUrl!;
          }
          if (detailBase64) {
            row.DETAIL_PICTURE_BASE64 = detailBase64;
            row.DETAIL_PICTURE_URL = detailUrl!;
          }
          const validMore = moreResults.filter((r) => r.base64);
          if (validMore.length > 0) {
            row.MORE_PHOTO_BASE64 = validMore.map((r) => r.base64);
            row.MORE_PHOTO_URLS = validMore.map((r) => r.url);
          }
        }
      }),
    );
  }
}

/**
 * Extract a downloadable image URL from a Bitrix24 image field value.
 * The field may be: an object `{ id, url, urlMachine, src }`, a plain
 * URL string, a numeric file ID (not downloadable), or null.
 */
function extractImageUrl(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string' && value.startsWith('http')) return value;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Try various URL fields that Bitrix24 may return
    for (const key of ['src', 'url', 'urlMachine', 'SRC', 'URL', 'downloadUrl', 'DOWNLOAD_URL']) {
      const v = obj[key];
      if (typeof v === 'string' && v.length > 0) {
        // Relative URLs need the portal prefix
        return v;
      }
    }
  }
  return null;
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
