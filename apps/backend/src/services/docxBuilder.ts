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
import type { FormulaEvaluationResult } from '@b24-doc-gen/shared';

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

  // 1) Replace formula-tag spans with their evaluated values.
  const stripped = stripFormulaTags(html, options.formulas ?? {});

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
    return escapeHtmlText(result.value ?? '');
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
};
