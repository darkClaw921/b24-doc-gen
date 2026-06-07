/**
 * docxTemplateEngine — substitute placeholders directly inside a .docx
 * template using docxtemplater, without the HTML intermediate step.
 *
 * The caller provides the original .docx buffer (as uploaded by the admin)
 * together with evaluated formula results and optional product rows.
 * The engine opens the archive via PizZip, builds a data object that maps
 * tag keys to their evaluated values, and lets docxtemplater perform the
 * substitution in-place — preserving all original Word formatting.
 *
 * Placeholder convention (single curly braces inside the .docx):
 *  - Simple values:   {tagKey}
 *  - Product loops:   {#products}...{/products}  with fields like
 *                     {PRODUCT_NAME}, {PRICE}, {QUANTITY}, {SUM}, etc.
 *  - Images:          {%IMAGE_TAG}  for data:image/ base64 URIs
 *  - Product images:  {%PREVIEW_PICTURE_BASE64}, {%DETAIL_PICTURE_BASE64}
 *
 * Public API:
 *  - `buildDocxFromTemplate(originalDocx, options)` → `Promise<Buffer>`
 *  - `scanDocxPlaceholders(originalDocx)`           → `string[]`
 *  - `DocxTemplateError` — custom error class
 */

import { createRequire } from 'node:module';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
// @ts-ignore — docxtemplater-image-module-free has no type declarations
import ImageModule from 'docxtemplater-image-module-free';
import type { FormulaEvaluationResult, ProductRow } from '@b24-doc-gen/shared';

const require = createRequire(import.meta.url);

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** Thrown when the .docx template processing pipeline fails. */
export class DocxTemplateError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'DocxTemplateError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

export interface BuildFromTemplateOptions {
  /**
   * Per-formula evaluation results, indexed by `tagKey`. Each entry
   * provides the evaluated value (or error) for a placeholder in the
   * template.
   */
  formulas: Record<string, FormulaEvaluationResult>;
  /**
   * Product rows attached to the deal. When provided, they are mapped
   * into the `products` array for `{#products}...{/products}` loops.
   */
  products?: ProductRow[];
  /**
   * Manual field values entered by the user at generation time, indexed
   * by `fieldKey`. They are substituted by the same `{fieldKey}` delimiters
   * as formulas. Formula values take precedence: if a `fieldKey` collides
   * with a formula `tagKey`, the formula value is kept and the manual field
   * value is ignored (manual fields fill gaps, they do not overwrite
   * computed values).
   */
  fieldValues?: Record<string, string>;
  /** Optional document title (informational, not used in rendering). */
  title?: string;
}

/* ------------------------------------------------------------------ */
/* Image helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * Convert a `data:image/...;base64,...` URI into an ArrayBuffer that
 * docxtemplater-image-module-free can embed into the archive.
 */
function base64DataURLToArrayBuffer(dataURL: string): ArrayBuffer | false {
  const base64Regex = /^data:image\/(png|jpg|jpeg|gif|svg|svg\+xml|webp|bmp);base64,/;
  if (!base64Regex.test(dataURL)) {
    return false;
  }
  const stringBase64 = dataURL.replace(base64Regex, '');
  const binaryString = Buffer.from(stringBase64, 'base64').toString('binary');
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

/** Default image dimensions (width × height in pixels). */
const DEFAULT_IMAGE_SIZE: [number, number] = [150, 150];

/**
 * Create an ImageModule instance configured to handle base64 data URI
 * images. Tags prefixed with `%` in the template (e.g. `{%logo}`) are
 * treated as image placeholders by docxtemplater-image-module-free.
 */
function createImageModule(): unknown {
  const opts = {
    centered: false,
    fileType: 'docx' as const,
    getImage(tagValue: string): ArrayBuffer | false {
      return base64DataURLToArrayBuffer(tagValue);
    },
    getSize(): [number, number] {
      return DEFAULT_IMAGE_SIZE;
    },
  };
  return new ImageModule(opts);
}

/* ------------------------------------------------------------------ */
/* Data mapping                                                        */
/* ------------------------------------------------------------------ */

/**
 * Build the data object that docxtemplater receives for `render()`.
 *
 * - Each formula result is mapped as `data[tagKey] = evaluatedValue`.
 *   On error, the label is used so the document reads naturally.
 * - Each manual field is mapped as `data[fieldKey] = value`, using the
 *   same `{fieldKey}` delimiters as formulas. Formula values win on key
 *   collisions — manual fields only fill keys not already produced by a
 *   formula.
 * - Product rows are mapped into `data.products` — an array of plain
 *   objects with the fields that `{#products}` loops reference.
 */
function buildDataObject(
  formulas: Record<string, FormulaEvaluationResult>,
  products: ProductRow[],
  fieldValues: Record<string, string> = {},
): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  // --- Manual field values ---
  // Filled first so that formulas (set below) take precedence on any
  // key collision: a formula `tagKey` overwrites a manual `fieldKey`.
  for (const [fieldKey, value] of Object.entries(fieldValues)) {
    data[fieldKey] = value ?? '';
  }

  // --- Formula values ---
  for (const [tagKey, result] of Object.entries(formulas)) {
    if (result.error) {
      // On error, fall back to the human-readable label so the
      // document doesn't show a raw error string.
      data[tagKey] = result.label || tagKey;
    } else {
      data[tagKey] = result.value ?? '';
    }
  }

  // --- Product rows ---
  // Always set `products` (even when empty) so that
  // {#products}...{/products} loops render an empty section
  // instead of leaving raw tags in the output.
  data.products = products.map((p, idx) => ({
    // Row index (1-based)
    INDEX: idx + 1,
    // Core fields
    PRODUCT_NAME: p.PRODUCT_NAME ?? '',
    PRICE: p.PRICE ?? 0,
    QUANTITY: p.QUANTITY ?? 0,
    DISCOUNT_SUM: p.DISCOUNT_SUM ?? 0,
    TAX_RATE: p.TAX_RATE ?? 0,
    SUM: p.SUM ?? 0,
    MEASURE_NAME: p.MEASURE_NAME ?? '',
    SORT: p.SORT ?? 0,
    PRODUCT_ID: p.PRODUCT_ID ?? 0,
    ID: p.ID ?? 0,
    // Image fields — base64 data URIs for {%...} image tags inside
    // the {#products} loop.  Empty string → image module emits empty
    // XML (no broken image placeholder).
    PREVIEW_PICTURE_BASE64: p.PREVIEW_PICTURE_BASE64 ?? '',
    DETAIL_PICTURE_BASE64: p.DETAIL_PICTURE_BASE64 ?? '',
    MORE_PHOTO_BASE64: p.MORE_PHOTO_BASE64 ?? [],
  }));

  return data;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Render a .docx template by substituting placeholders with evaluated
 * formula values and product data.
 *
 * @param originalDocx  Buffer containing the original .docx archive.
 * @param options       Formula results, product rows, and optional title.
 * @returns             A new .docx Buffer with all placeholders filled.
 *
 * @throws {DocxTemplateError} on empty input, corrupt zip, or render failure.
 */
export async function buildDocxFromTemplate(
  originalDocx: Buffer,
  options: BuildFromTemplateOptions,
): Promise<Buffer> {
  if (!originalDocx || originalDocx.length === 0) {
    throw new DocxTemplateError('Empty .docx buffer', 'EMPTY_DOCX');
  }

  // 1. Open the archive.
  let zip: PizZip;
  try {
    zip = new PizZip(originalDocx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DocxTemplateError(`Failed to open .docx archive: ${msg}`, 'ZIP_FAILED');
  }

  // 2. Build the data object from formula results + manual fields + products.
  const data = buildDataObject(
    options.formulas,
    options.products ?? [],
    options.fieldValues ?? {},
  );

  // 3. Always attach the image module so that {%TAG} placeholders in
  //    the template are recognised regardless of whether the current
  //    data actually contains image values.  The module gracefully
  //    handles falsy tag values (empty strings) by emitting empty XML.
  const imageModule = createImageModule();

  let doc: Docxtemplater;
  try {
    doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      delimiters: { start: '{', end: '}' },
      nullGetter(): string {
        // Return empty string for any tag not present in the data
        // object — this prevents docxtemplater from throwing on
        // missing placeholders.
        return '';
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      modules: [imageModule] as any[],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DocxTemplateError(`Template compilation failed: ${msg}`, 'COMPILE_FAILED');
  }

  // 4. Render the template with data.
  try {
    doc.render(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DocxTemplateError(`Template render failed: ${msg}`, 'RENDER_FAILED');
  }

  // 5. Generate the output .docx buffer.
  try {
    const buffer = doc.getZip().generate({
      type: 'nodebuffer',
      compression: 'DEFLATE',
    }) as Buffer;
    return buffer;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DocxTemplateError(`Output generation failed: ${msg}`, 'GENERATE_FAILED');
  }
}

/* ------------------------------------------------------------------ */
/* Placeholder scanner                                                 */
/* ------------------------------------------------------------------ */

// Imported lazily to keep the top-level import list clean — the
// inspect module is a CJS sub-path export without types.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const inspectModule = require('docxtemplater/js/inspect-module.js');

/**
 * Extract all placeholder tag names from a .docx template.
 *
 * Uses docxtemplater's `InspectModule` to parse the template and
 * collect every tag reference. Returns a unique, sorted array of
 * tag names (including loop section names and their nested fields).
 *
 * @param originalDocx  Buffer containing the .docx archive.
 * @returns             Sorted array of unique tag names found in the template.
 *                      Returns an empty array on invalid/empty input.
 */
export function scanDocxPlaceholders(originalDocx: Buffer): string[] {
  if (!originalDocx || originalDocx.length === 0) {
    return [];
  }

  let zip: PizZip;
  try {
    zip = new PizZip(originalDocx);
  } catch {
    // Corrupt or non-zip buffer — return empty list instead of throwing.
    return [];
  }

  try {
    const iModule = inspectModule();
    // We don't need the image module for scanning — just parse tags.
    new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      delimiters: { start: '{', end: '}' },
      nullGetter(): string {
        return '';
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      modules: [iModule as any],
    });

    const tags = iModule.getAllTags() as Record<string, unknown>;
    const names: Set<string> = new Set();
    collectTagNames(tags, names);
    return Array.from(names).sort();
  } catch {
    // Any docxtemplater error during inspection — return empty list.
    return [];
  }
}

/**
 * Recursively collect tag names from the nested object returned by
 * `InspectModule.getAllTags()`.
 *
 * The shape is `{ tagName: {} }` for simple tags, and
 * `{ sectionName: { nestedTag: {} } }` for loop sections.
 */
function collectTagNames(
  tags: Record<string, unknown>,
  out: Set<string>,
  prefix = '',
): void {
  for (const [key, value] of Object.entries(tags)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    out.add(key);
    if (value && typeof value === 'object' && Object.keys(value as Record<string, unknown>).length > 0) {
      collectTagNames(value as Record<string, unknown>, out, fullKey);
    }
  }
}
