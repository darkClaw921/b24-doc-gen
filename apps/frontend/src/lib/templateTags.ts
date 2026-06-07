/**
 * templateTags — helpers for the template editor's "Теги шаблона" panel.
 *
 * The editor lists every placeholder tag found in the uploaded `.docx`
 * (via the backend's `scanDocxPlaceholders`) and lets the admin bind each
 * one to either a formula (computed from CRM data) or a manual field
 * (filled in at generation time). Tags that are part of the product-loop
 * machinery (`{#products}…{/products}` and the per-row fields it renders)
 * are *reserved*: the generation engine fills them automatically, so they
 * never need a manual binding and must not be flagged as "unbound".
 *
 * This module centralises:
 *  - the canonical set of reserved product-loop tag names (kept in sync
 *    with `apps/backend/src/services/docxTemplateEngine.ts`);
 *  - the per-tag binding-status computation used to render the panel.
 */

/**
 * Tags reserved by the product-loop / image machinery. These are filled
 * automatically by `buildDocxFromTemplate` when it renders the
 * `{#products}…{/products}` loop, so they require no admin binding.
 *
 * Mirrors the `products` row object built in `docxTemplateEngine.ts`
 * (`buildTemplateData`) plus the loop section name itself.
 */
export const RESERVED_PRODUCT_TAGS: ReadonlySet<string> = new Set([
  // Loop section name (appears as `products` in the inspected tag tree).
  'products',
  // Per-row fields rendered inside the loop.
  'INDEX',
  'PRODUCT_NAME',
  'PRICE',
  'QUANTITY',
  'DISCOUNT_SUM',
  'TAX_RATE',
  'SUM',
  'MEASURE_NAME',
  'SORT',
  'PRODUCT_ID',
  'ID',
  // Product image fields ({%...} image tags inside the loop).
  'PREVIEW_PICTURE_BASE64',
  'DETAIL_PICTURE_BASE64',
  'MORE_PHOTO_BASE64',
]);

/**
 * Returns true when `tag` is a reserved product-loop / image tag that the
 * generation engine fills automatically and therefore must not be treated
 * as an unbound placeholder in the editor.
 */
export function isReservedTag(tag: string): boolean {
  return RESERVED_PRODUCT_TAGS.has(tag.trim());
}

/** Binding kind for a template tag. */
export type TagBindingStatus = 'formula' | 'field' | 'reserved' | 'unbound';

/**
 * Compute the binding status of a single tag against the current
 * formula/field maps. Reserved product tags short-circuit to `reserved`;
 * otherwise a tag is `formula` / `field` when a matching `tagKey` /
 * `fieldKey` exists, and `unbound` when neither does.
 */
export function computeTagStatus(
  tag: string,
  formulaKeys: ReadonlySet<string>,
  fieldKeys: ReadonlySet<string>,
): TagBindingStatus {
  if (isReservedTag(tag)) return 'reserved';
  if (formulaKeys.has(tag)) return 'formula';
  if (fieldKeys.has(tag)) return 'field';
  return 'unbound';
}
