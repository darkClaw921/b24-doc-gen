/**
 * docxBuilder — convert a TipTap-rendered HTML string into a real
 * `.docx` Buffer for download or attachment to a Bitrix24 disk folder.
 *
 * @deprecated LEGACY — not used by the active pipeline. Generation and
 * preview now render directly from the admin-uploaded original `.docx`
 * via {@link buildDocxFromTemplate} (docxTemplateEngine), which keeps
 * the source formatting 1:1 instead of round-tripping through HTML.
 * Both `buildDocxFromHtml` and `expandProductTables` are dead code kept
 * only for reference and are scheduled for removal in a follow-up
 * cleanup. Do not reintroduce the HTML→.docx path.
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
import PizZip from 'pizzip';
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
  /**
   * Original .docx buffer (as uploaded by the admin). When provided,
   * the generated body content is injected into the original document's
   * shell — preserving styles, fonts, headers, footers, page settings,
   * theme, and numbering from the original file.
   */
  originalDocx?: Buffer;
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

  // 4) Normalize the response to a Node Buffer.
  const generatedBuffer = await coerceToBuffer(raw);

  // 5) If an original .docx is available, merge: take the original
  //    document's shell (styles, fonts, headers, footers, page settings,
  //    theme, numbering) and inject the generated body content into it.
  //    This preserves the original document's visual formatting.
  if (options.originalDocx && options.originalDocx.length > 0) {
    try {
      return mergeWithOriginalDocx(options.originalDocx, generatedBuffer);
    } catch (err) {
      // If merging fails, fall back to the plain generated buffer
      // rather than breaking the entire generation.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[docxBuilder] merge with original .docx failed, using generated: ${message}`);
    }
  }

  return generatedBuffer;
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

  return html.replace(tableRe, (fullMatch, tableInner: string) => {
    // Skip tables that don't contain any product placeholders —
    // only process tables that have data-product-field, data-product-image,
    // or data-product-index spans (or the explicit data-product-table attr).
    const hasProductPlaceholders = /data-product-(?:field|image|index)/.test(fullMatch);
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
        return `<img src="${base64}" style="max-width:80px;max-height:80px;display:block;" />`;
      }
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

/* ------------------------------------------------------------------ */
/* Original .docx formatting merge                                    */
/* ------------------------------------------------------------------ */

/**
 * Files to copy from the original .docx into the generated .docx.
 * These carry the visual formatting that mammoth/html-to-docx strips.
 */
const FORMATTING_FILES = [
  'word/fontTable.xml',     // font declarations
  'word/numbering.xml',     // list numbering definitions
  // NOTE: word/styles.xml and word/settings.xml are intentionally
  // NOT copied — they define paragraph/table styles (alignment,
  // spacing, borders) that conflict with the generated content.
  // Copying them causes tables to break and text to re-align.
];

/**
 * Copy formatting assets from the original .docx into the generated
 * .docx. The generated document already has valid content (body with
 * formula values and product tables); we just upgrade its formatting
 * by overwriting the style/theme/font files with the originals.
 *
 * Additionally, the `<w:sectPr>` (section properties) from the
 * original document.xml is transplanted into the generated
 * document.xml so page size, margins, orientation, and
 * header/footer references are preserved.
 */
function mergeWithOriginalDocx(
  originalDocx: Buffer,
  generatedDocx: Buffer,
): Buffer {
  const origZip = new PizZip(originalDocx);
  const genZip = new PizZip(generatedDocx);

  // 1) Copy formatting files from original → generated.
  for (const path of FORMATTING_FILES) {
    const file = origZip.file(path);
    if (file) {
      genZip.file(path, file.asUint8Array());
    }
  }

  // 2) Copy theme directory (word/theme/*) from original.
  for (const [path, file] of Object.entries(origZip.files)) {
    if (path.startsWith('word/theme/') && !file.dir) {
      genZip.file(path, file.asUint8Array());
    }
  }

  // 3) Copy headers and footers from original, plus their rels.
  for (const [path, file] of Object.entries(origZip.files)) {
    if (/^word\/(header|footer)\d*\.xml$/.test(path) && !file.dir) {
      genZip.file(path, file.asUint8Array());
    }
    // Also copy header/footer relationship files.
    if (/^word\/_rels\/(header|footer)\d*\.xml\.rels$/.test(path) && !file.dir) {
      genZip.file(path, file.asUint8Array());
    }
  }

  // 4) Copy any media files from original (logos, header images, etc.)
  for (const [path, file] of Object.entries(origZip.files)) {
    if (path.startsWith('word/media/') && !file.dir) {
      // Prefix to avoid collision with generated media.
      const name = path.slice('word/media/'.length);
      genZip.file(`word/media/orig_${name}`, file.asUint8Array());
    }
  }

  // 5) Transplant <w:sectPr> from original document.xml into generated.
  //    sectPr controls page size, margins, orientation, header/footer refs.
  const origDocXml = origZip.file('word/document.xml')?.asText();
  const genDocXml = genZip.file('word/document.xml')?.asText();

  if (origDocXml && genDocXml) {
    const origSectPrMatch = origDocXml.match(/<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>/);
    if (origSectPrMatch) {
      const origSectPr = origSectPrMatch[0];
      let updatedGenDocXml: string;

      // Replace existing sectPr in generated, or insert before </w:body>.
      if (/<w:sectPr\b/.test(genDocXml)) {
        updatedGenDocXml = genDocXml.replace(
          /<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>/,
          origSectPr,
        );
      } else {
        updatedGenDocXml = genDocXml.replace(
          '</w:body>',
          `${origSectPr}</w:body>`,
        );
      }
      genZip.file('word/document.xml', updatedGenDocXml);
    }
  }

  // 6) Merge relationships: add header/footer/theme rels from original
  //    into generated document.xml.rels.
  const origRels = origZip.file('word/_rels/document.xml.rels')?.asText() ?? '';
  const genRels = genZip.file('word/_rels/document.xml.rels')?.asText() ?? '';
  if (origRels && genRels) {
    // Extract header, footer, and theme relationships from original.
    const relTypes = ['header', 'footer', 'theme', 'fontTable', 'numbering', 'settings'];
    const relRe = /<Relationship\b[^>]*\/>/gi;
    const origAllRels = origRels.match(relRe) ?? [];
    const relsToAdd: string[] = [];

    // Find max rId in generated to avoid collisions.
    const rIdRe = /Id="rId(\d+)"/g;
    let maxId = 0;
    let m: RegExpExecArray | null;
    while ((m = rIdRe.exec(genRels)) !== null) {
      const id = parseInt(m[1], 10);
      if (id > maxId) maxId = id;
    }

    for (const rel of origAllRels) {
      const typeMatch = rel.match(/Type="[^"]*\/(\w+)"/);
      if (!typeMatch) continue;
      const typeName = typeMatch[1].toLowerCase();
      if (!relTypes.includes(typeName)) continue;

      // Skip if generated already has this type.
      if (genRels.includes(`/${typeName}"`)) continue;

      // Remap the rId.
      maxId++;
      const remapped = rel
        .replace(/Id="rId\d+"/, `Id="rId${maxId}"`)
        // Fix media paths for original media files we prefixed.
        .replace(/Target="media\/([^"]+)"/, 'Target="media/orig_$1"');
      relsToAdd.push(remapped);
    }

    if (relsToAdd.length > 0) {
      const updatedRels = genRels.replace(
        '</Relationships>',
        relsToAdd.join('') + '</Relationships>',
      );
      genZip.file('word/_rels/document.xml.rels', updatedRels);
    }
  }

  // 7) Ensure [Content_Types].xml has entries for any new file types.
  const genCT = genZip.file('[Content_Types].xml')?.asText() ?? '';
  const origCT = origZip.file('[Content_Types].xml')?.asText() ?? '';
  if (genCT && origCT) {
    // Copy Override entries for headers/footers from original.
    const overrideRe = /<Override\b[^>]*PartName="\/word\/(header|footer)\d*\.xml"[^>]*\/>/gi;
    const origOverrides = origCT.match(overrideRe) ?? [];
    const missingOverrides = origOverrides.filter((o) => !genCT.includes(o));
    if (missingOverrides.length > 0) {
      const updatedCT = genCT.replace(
        '</Types>',
        missingOverrides.join('') + '</Types>',
      );
      genZip.file('[Content_Types].xml', updatedCT);
    }
  }

  return genZip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
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
