/**
 * docxBuilder — convert a TipTap-rendered HTML string into a real
 * `.docx` Buffer for download or attachment to a Bitrix24 disk folder.
 *
 * Why we use `@turbodocx/html-to-docx`:
 *  - Pure JavaScript with no native dependencies, so the backend can
 *    keep running on a vanilla Node 18+ image.
 *  - Handles tables, headings, lists, basic inline formatting and
 *    base64-embedded images, which is what mammoth-derived templates
 *    typically contain.
 *  - Returns either a Buffer (Node) or an ArrayBuffer (browser); we
 *    always coerce the result to a Node Buffer for the disk upload.
 *
 * Pipeline:
 *  1. The caller (`routes/generate.ts::POST /api/generate`) builds
 *     the per-formula evaluation map and passes the *original* HTML
 *     here. We strip the formula tags ourselves: every
 *     `<span data-formula-key="…">` is replaced by its computed value
 *     (or, if the formula failed, by the label so the document still
 *     reads naturally).
 *  2. The cleaned HTML is wrapped in a small `<!DOCTYPE>` shell so
 *     html-to-docx parses encoding/lang correctly. We force UTF-8 and
 *     set lang="ru" so Cyrillic text round-trips through Word.
 *  3. html-to-docx is invoked with portrait Arial and standard A4
 *     margins. The result is normalized to a Node Buffer.
 *
 * Public API:
 *  - `buildDocxFromHtml(html, formulas?)` → `Promise<Buffer>` —
 *      `formulas` is the same `Record<tagKey, FormulaEvaluationResult>`
 *      shape produced by the preview endpoint. If omitted, formula
 *      tags are simply stripped to their label so existing tests can
 *      pass plain HTML.
 *  - `DocxBuildError` thrown when the HTML is empty or html-to-docx
 *      itself blows up. Routes wrap this in a 502/500 response.
 */

import HTMLtoDOCX from '@turbodocx/html-to-docx';
import type { FormulaEvaluationResult, ProductRow } from '@b24-doc-gen/shared';

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** Thrown when the .docx generation pipeline fails. */
export class DocxBuildError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'DocxBuildError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export interface BuildDocxOptions {
  /**
   * Per-formula evaluation results, indexed by `tagKey`. Used to
   * substitute `<span data-formula-key>` placeholders before the HTML
   * is converted. Optional.
   */
  formulas?: Record<string, FormulaEvaluationResult>;
  /**
   * Optional document title saved into the .docx core properties.
   */
  title?: string;
  /**
   * Product rows attached to the deal. When provided, product-table
   * placeholders (`<table data-product-table="true">`) are expanded
   * into N rows — one per product.
   */
  products?: ProductRow[];
}

/**
 * Convert an HTML string into a Word `.docx` Buffer.
 *
 * If a `formulas` map is provided, every formula-tag span is replaced
 * by its computed value (or by the label on error). The output is a
 * Node `Buffer` ready to be uploaded via `B24Client.uploadDiskFile`.
 *
 * Throws `DocxBuildError` on empty/blank input or html-to-docx failure.
 */
export async function buildDocxFromHtml(
  html: string,
  options: BuildDocxOptions = {},
): Promise<Buffer> {
  if (typeof html !== 'string' || html.trim().length === 0) {
    throw new DocxBuildError('Empty HTML', 'EMPTY_HTML');
  }

  // 1a) Expand product-table rows (must happen before formula substitution
  //     so that any formulas inside the template row are still intact).
  const expanded = expandProductTables(html, options.products ?? []);

  // 1b) Replace formula-tag spans with their evaluated values.
  const stripped = stripFormulaTags(expanded, options.formulas ?? {});

  // 2) Wrap in a minimal HTML5 shell so the parser knows the encoding
  //    and language. Cyrillic text otherwise lands as ?-?-? in Word.
  const wrapped = wrapAsHtmlDocument(stripped, options.title ?? 'Документ');

  // 3) Invoke html-to-docx with sane defaults.
  let raw: ArrayBuffer | Blob | Buffer;
  try {
    raw = await HTMLtoDOCX(
      wrapped,
      null,
      {
        orientation: 'portrait',
        font: 'Arial',
        fontSize: 22, // half-points → 11pt
        title: options.title,
        creator: 'b24-doc-gen',
        lang: 'ru-RU',
        // A4 margins (twips). Word's default is 1 inch ≈ 1440 twips.
        margins: {
          top: 1440,
          right: 1440,
          bottom: 1440,
          left: 1440,
        },
        table: {
          row: { cantSplit: true },
          borderOptions: {
            size: 1,
            color: '000000',
          },
        },
      },
      null,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DocxBuildError(`html-to-docx failed: ${message}`, 'CONVERT_FAILED');
  }

  // 4) Normalize the response to a Node Buffer regardless of what the
  //    library handed back. In Node, html-to-docx already returns a
  //    Buffer, but the typing union includes ArrayBuffer/Blob.
  return await coerceToBuffer(raw);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Product-table expansion                                             */
/* ------------------------------------------------------------------ */

/**
 * Expand every `<table data-product-table="true">` block in the HTML.
 *
 * The convention is:
 *  - The **last** `<tr>` inside `<tbody>` is the *template row*. It
 *    contains placeholder spans (`data-product-field`, `data-product-image`,
 *    `data-product-index`) that are substituted per product.
 *  - The template row is cloned N times (once per product), placeholders
 *    are filled, and the original template row is removed.
 *  - If `products` is empty the template row is simply deleted, leaving
 *    the table header intact but the body empty.
 *
 * Tables without `data-product-table` are not touched.
 */
export function expandProductTables(html: string, products: ProductRow[]): string {
  // Match product tables in two ways:
  //  1) Explicitly marked: <table data-product-table="true">
  //  2) Auto-detect: any <table> that contains data-product-field spans
  //     (TipTap may strip data-product-table if the Table node doesn't
  //     persist it — this fallback ensures expansion still works).
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;

  console.log('[expandProductTables] products count:', products.length);
  console.log('[expandProductTables] html contains data-product-field:', html.includes('data-product-field'));
  console.log('[expandProductTables] html contains data-product-image:', html.includes('data-product-image'));

  return html.replace(tableRe, (fullMatch, tableInner: string) => {
    // Skip tables that don't contain any product placeholders —
    // only process tables that have data-product-field, data-product-image,
    // or data-product-index spans (or the explicit data-product-table attr).
    const hasProductPlaceholders = /data-product-(?:field|image|index)/.test(fullMatch);
    console.log('[expandProductTables] table found, hasProductPlaceholders:', hasProductPlaceholders);
    if (!hasProductPlaceholders) {
      return fullMatch;
    }

    // TipTap Table extension does NOT produce <thead>/<tbody> — it outputs
    // a flat sequence of <tr> rows directly inside <table>. The first row
    // with <th> cells is the header; the last row containing product
    // placeholders (data-product-field / data-product-image / data-product-index)
    // is the template row.

    // Collect all <tr>…</tr> blocks. Use a greedy-enough pattern that
    // handles multi-line cell content (TipTap wraps cell text in <p>).
    const trRe = /<tr\b[^>]*>[\s\S]*?<\/tr>/gi;
    const allRows = tableInner.match(trRe);
    if (!allRows || allRows.length === 0) return fullMatch;

    // Identify the template row — it's the row that contains at least one
    // product placeholder (data-product-field, data-product-image, or
    // data-product-index).
    const isTemplateRow = (row: string) =>
      /data-product-(?:field|image|index)/.test(row);

    let templateRowIdx = -1;
    for (let i = allRows.length - 1; i >= 0; i--) {
      if (isTemplateRow(allRows[i])) {
        templateRowIdx = i;
        break;
      }
    }
    if (templateRowIdx < 0) return fullMatch; // no template row found

    const templateRow = allRows[templateRowIdx];
    const headerRows = allRows.slice(0, templateRowIdx);
    const trailingRows = allRows.slice(templateRowIdx + 1);

    // Generate one row per product by substituting placeholders.
    const generatedRows = products.map((product, idx) =>
      fillProductRow(templateRow, product, idx + 1),
    );

    // Reassemble the table inner HTML: header rows + generated rows +
    // any trailing rows (unlikely but safe).
    const newRows = [...headerRows, ...generatedRows, ...trailingRows].join('');

    // Replace the original row sequence in the table. We rebuild the
    // full match by replacing the inner content between the opening
    // <table> tag and closing </table>.
    const openTagRe = /^(<table\b[^>]*>)/i;
    const openMatch = fullMatch.match(openTagRe);
    if (!openMatch) return fullMatch;
    const openTag = openMatch[1];

    // If there was a <tbody>, wrap the rows in it; otherwise keep flat.
    const hasTbody = /<tbody/i.test(tableInner);
    if (hasTbody) {
      // Preserve the original <tbody ...> open tag if present.
      const tbodyOpenRe = /<tbody[^>]*>/i;
      const tbodyOpenMatch = tableInner.match(tbodyOpenRe);
      const tbodyOpen = tbodyOpenMatch ? tbodyOpenMatch[0] : '<tbody>';
      // Also preserve any <thead> block if present.
      const theadRe = /<thead[^>]*>[\s\S]*?<\/thead>/i;
      const theadMatch = tableInner.match(theadRe);
      const thead = theadMatch ? theadMatch[0] : '';
      return `${openTag}${thead}${tbodyOpen}${newRows}</tbody></table>`;
    }

    return `${openTag}${newRows}</table>`;
  });
}

/**
 * Substitute product placeholders inside a single template `<tr>`.
 *
 * Recognised placeholder patterns:
 *  - `<span data-product-field="FIELD">…</span>` → escaped field value
 *  - `<span data-product-image="true">…</span>`  → `<img>` with base64 src
 *  - `<span data-product-index>…</span>`          → 1-based row number
 */
function fillProductRow(rowHtml: string, product: ProductRow, index: number): string {
  let result = rowHtml;

  // 1) data-product-field="FIELD"
  result = result.replace(
    /<span\b[^>]*data-product-field=["']([^"']+)["'][^>]*>[\s\S]*?<\/span>/gi,
    (_match, fieldName: string) => {
      const value = (product as unknown as Record<string, unknown>)[fieldName];
      return escapeHtmlText(value == null ? '' : String(value));
    },
  );

  // 2) data-product-image="TYPE" (preview|detail|more_photo, default preview)
  result = result.replace(
    /<span\b[^>]*data-product-image=["']([^"']*)["'][^>]*>[\s\S]*?<\/span>/gi,
    (_m, imageType: string) => {
      const type = (imageType || 'true').toLowerCase();
      console.log(`[fillProductRow] image replacement: imageType="${imageType}", resolved type="${type}"`);
      console.log(`[fillProductRow] PREVIEW_PICTURE_BASE64: ${product.PREVIEW_PICTURE_BASE64 ? 'yes (' + product.PREVIEW_PICTURE_BASE64.length + ' chars)' : 'no'}`);
      console.log(`[fillProductRow] DETAIL_PICTURE_BASE64: ${product.DETAIL_PICTURE_BASE64 ? 'yes' : 'no'}`);
      console.log(`[fillProductRow] MORE_PHOTO_BASE64: ${product.MORE_PHOTO_BASE64 ? product.MORE_PHOTO_BASE64.length + ' items' : 'no'}`);
      let base64: string | undefined;
      if (type === 'detail') {
        base64 = product.DETAIL_PICTURE_BASE64;
      } else if (type === 'more_photo' || type === 'more') {
        base64 = product.MORE_PHOTO_BASE64?.[0];
      } else {
        // "true", "preview", or default — try preview → detail → more_photo[0]
        base64 = product.PREVIEW_PICTURE_BASE64
          ?? product.DETAIL_PICTURE_BASE64
          ?? product.MORE_PHOTO_BASE64?.[0];
      }
      if (base64) {
        console.log(`[fillProductRow] generating <img> tag, base64 length: ${base64.length}`);
        return `<img src="${base64}" style="max-width:80px;max-height:80px;display:block;" />`;
      }
      console.log(`[fillProductRow] no image data found`);
      return '';
    },
  );

  // 3) data-product-index
  result = result.replace(
    /<span\b[^>]*data-product-index[^>]*>[\s\S]*?<\/span>/gi,
    () => escapeHtmlText(String(index)),
  );

  return result;
}

/* ------------------------------------------------------------------ */
/* Formula substitution                                                */
/* ------------------------------------------------------------------ */

/**
 * Replace every `<span data-formula-key="…">…</span>` with the
 * evaluated value (or the original label on error). Mirrors the
 * regex used by `routes/templates.ts::substituteFormulaTagsForPreview`
 * but emits plain text instead of an annotated span — html-to-docx
 * doesn't need our preview metadata.
 */
function stripFormulaTags(
  html: string,
  formulas: Record<string, FormulaEvaluationResult>,
): string {
  const re = /<span\b[^>]*?data-formula-key=["']([^"']+)["'][^>]*>([\s\S]*?)<\/span>/gi;
  return html.replace(re, (_match, tagKey: string, inner: string) => {
    const result = formulas[tagKey];
    if (!result) {
      // No data — fall back to the inner text the editor rendered
      // (typically "Σ label"). Drop the leading "Σ " marker so the
      // document doesn't show the placeholder symbol.
      return escapeHtmlText(inner.replace(/^Σ\s*/, ''));
    }
    if (result.error) {
      return escapeHtmlText(result.label || result.tagKey);
    }
    const val = result.value ?? '';
    // If the formula produced a data-URI image (e.g. productImage(1)),
    // emit an <img> tag so html-to-docx embeds the picture into the .docx.
    if (val.startsWith('data:image/')) {
      return `<img src="${val}" style="max-width:200px;max-height:200px;" />`;
    }
    return escapeHtmlText(val);
  });
}

/** Wrap a body fragment in a minimal HTML5 document. */
function wrapAsHtmlDocument(body: string, title: string): string {
  return (
    `<!DOCTYPE html>` +
    `<html lang="ru">` +
    `<head>` +
    `<meta charset="UTF-8" />` +
    `<title>${escapeHtmlText(title)}</title>` +
    `</head>` +
    `<body>` +
    body +
    `</body>` +
    `</html>`
  );
}

/** Minimal HTML text escaper used inside text nodes. */
function escapeHtmlText(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Normalize the html-to-docx output to a Node Buffer regardless of
 * which underlying type it returned. In Node, html-to-docx already
 * yields a Buffer; we still handle ArrayBuffer/Blob to satisfy the
 * type union exposed by the package.
 */
async function coerceToBuffer(
  raw: ArrayBuffer | Blob | Buffer,
): Promise<Buffer> {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(new Uint8Array(raw));
  // Blob (browser case — should not normally happen on the server).
  if (typeof (raw as Blob).arrayBuffer === 'function') {
    const ab = await (raw as Blob).arrayBuffer();
    return Buffer.from(new Uint8Array(ab));
  }
  throw new DocxBuildError(
    `Unsupported html-to-docx output type: ${typeof raw}`,
    'BAD_OUTPUT',
  );
}

/* ------------------------------------------------------------------ */
/* Internal hooks for tests                                            */
/* ------------------------------------------------------------------ */

export const __internal = {
  stripFormulaTags,
  wrapAsHtmlDocument,
  expandProductTables,
  fillProductRow,
};
