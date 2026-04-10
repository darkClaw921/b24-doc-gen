/**
 * pdfBuilder — convert TipTap-rendered HTML into a PDF Buffer using
 * Puppeteer (headless Chrome).
 *
 * Pipeline:
 *  1. Expand product-table placeholders.
 *  2. Substitute formula-tag spans with computed values.
 *  3. Wrap in a styled HTML5 document with print-ready CSS.
 *  4. Render to PDF via Puppeteer with A4 page size and margins.
 *
 * The PDF faithfully reproduces the HTML layout — tables, images,
 * fonts, and spacing are rendered by a real browser engine.
 *
 * Public API:
 *  - `buildPdfFromHtml(html, options?)` → `Promise<Buffer>`
 *  - `PdfBuildError` — custom error class
 */

import puppeteer, { type Browser } from 'puppeteer';
import type { FormulaEvaluationResult, ProductRow } from '@b24-doc-gen/shared';
import { expandProductTables } from './docxBuilder.js';

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class PdfBuildError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'PdfBuildError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

export interface BuildPdfOptions {
  formulas?: Record<string, FormulaEvaluationResult>;
  title?: string;
  products?: ProductRow[];
}

/* ------------------------------------------------------------------ */
/* Singleton browser                                                   */
/* ------------------------------------------------------------------ */

let browserInstance: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }
  browserInstance = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });
  return browserInstance;
}

/** Shut down the shared browser (call on server close). */
export async function closePdfBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export async function buildPdfFromHtml(
  html: string,
  options: BuildPdfOptions = {},
): Promise<Buffer> {
  if (typeof html !== 'string' || html.trim().length === 0) {
    throw new PdfBuildError('Empty HTML', 'EMPTY_HTML');
  }

  // 1) Expand product-table rows.
  const expanded = expandProductTables(html, options.products ?? []);

  // 2) Replace formula-tag spans with evaluated values.
  const stripped = stripFormulaTags(expanded, options.formulas ?? {});

  // 3) Wrap in a styled HTML document.
  const wrapped = wrapAsStyledHtml(stripped, options.title ?? 'Документ');

  // 4) Render to PDF via Puppeteer.
  let browser: Browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PdfBuildError(`Failed to launch browser: ${msg}`, 'BROWSER_FAILED');
  }

  const page = await browser.newPage();
  try {
    await page.setContent(wrapped, { waitUntil: 'domcontentloaded', timeout: 15_000 });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '20mm',
        right: '15mm',
        bottom: '20mm',
        left: '15mm',
      },
    });

    return Buffer.from(pdfBuffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PdfBuildError(`PDF rendering failed: ${msg}`, 'RENDER_FAILED');
  } finally {
    await page.close().catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function stripFormulaTags(
  html: string,
  formulas: Record<string, FormulaEvaluationResult>,
): string {
  const re = /<span\b[^>]*?data-formula-key=["']([^"']+)["'][^>]*>([\s\S]*?)<\/span>/gi;
  return html.replace(re, (_match, tagKey: string, inner: string) => {
    const result = formulas[tagKey];
    if (!result) {
      return escapeHtml(inner.replace(/^Σ\s*/, ''));
    }
    if (result.error) {
      return escapeHtml(result.label || result.tagKey);
    }
    const val = result.value ?? '';
    if (val.startsWith('data:image/')) {
      return `<img src="${val}" style="max-width:200px;max-height:200px;" />`;
    }
    return escapeHtml(val);
  });
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function wrapAsStyledHtml(body: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<title>${escapeHtml(title)}</title>
<style>
  /* Reset & base */
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'Times New Roman', 'PT Serif', Georgia, serif;
    font-size: 12pt;
    line-height: 1.5;
    color: #000;
  }

  /* Headings */
  h1 { font-size: 18pt; font-weight: bold; margin: 12pt 0 6pt; }
  h2 { font-size: 16pt; font-weight: bold; margin: 10pt 0 5pt; }
  h3 { font-size: 14pt; font-weight: bold; margin: 8pt 0 4pt; }
  h4, h5, h6 { font-size: 12pt; font-weight: bold; margin: 6pt 0 3pt; }

  /* Paragraphs */
  p { margin: 0 0 6pt; }

  /* Tables */
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 8pt 0;
    font-size: 11pt;
  }
  th, td {
    border: 1px solid #333;
    padding: 4pt 6pt;
    text-align: left;
    vertical-align: top;
  }
  th {
    background-color: #f0f0f0;
    font-weight: bold;
  }

  /* Lists */
  ul, ol { margin: 4pt 0 4pt 20pt; }
  li { margin-bottom: 2pt; }

  /* Images */
  img {
    max-width: 100%;
    height: auto;
  }

  /* Blockquotes */
  blockquote {
    border-left: 3px solid #ccc;
    padding-left: 10pt;
    margin: 6pt 0;
    color: #333;
  }

  /* Strong / emphasis */
  strong, b { font-weight: bold; }
  em, i { font-style: italic; }

  /* Print adjustments */
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
${body}
</body>
</html>`;
}
