/**
 * render-check — диагностический скрипт.
 *
 * Для каждого .docx из папки «шаблоны для первичного обращения»:
 *  1) parseDocxToHtml (mammoth)          → HTML («до генерации» / preview)
 *  2) buildPdfFromHtml (Puppeteer)        → реальный PDF («после генерации»)
 *  3) скриншот preview-вида (стили фронтенда gen-preview-html)
 *  4) скриншот pdf-вида (тот же print-HTML, что уходит в PDF)
 *
 * Результаты складываются в <папка>/_render-check/.
 *
 * Запуск:
 *   pnpm -F backend exec tsx scripts/render-check.ts
 */

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { parseDocxToHtml } from '../src/services/docxParser.js';
import { buildPdfFromHtml, closePdfBrowser } from '../src/services/pdfBuilder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// repo root: apps/backend/scripts → ../../..
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_DIR = path.join(REPO_ROOT, 'шаблоны для первичного обращения');
const OUT_DIR = path.join(SRC_DIR, '_render-check');

// CSS превью фронтенда (скопирован из apps/frontend/src/pages/GeneratePage.tsx
// PREVIEW_STYLES) — чтобы скриншот «до генерации» совпадал с тем, что видит
// пользователь во вкладке «Сгенерировать».
const PREVIEW_STYLES = `
  .gen-preview-html { font-family: Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #1a1a1a; overflow-wrap: break-word; }
  .gen-preview-html h1 { font-size: 1.5rem; font-weight: 600; margin: 1rem 0; }
  .gen-preview-html h2 { font-size: 1.25rem; font-weight: 600; margin: 0.75rem 0; }
  .gen-preview-html h3 { font-size: 1.125rem; font-weight: 600; margin: 0.5rem 0; }
  .gen-preview-html p { margin: 0.5rem 0; line-height: 1.6; }
  .gen-preview-html ul, .gen-preview-html ol { margin: 0.5rem 0 0.5rem 1.5rem; }
  .gen-preview-html table { border-collapse: collapse; margin: 0.5rem 0; width: 100%; }
  .gen-preview-html table colgroup { display: none; }
  .gen-preview-html th, .gen-preview-html td { border: 1px solid #999; padding: 4px 8px; vertical-align: middle; font-size: 11pt; }
  .gen-preview-html th { background: #f0f0f0; font-weight: 600; text-align: left; }
  .gen-preview-html td p, .gen-preview-html th p { margin: 0; }
`;

// CSS финального PDF (скопирован из pdfBuilder.ts wrapAsStyledHtml) — для
// скриншота «после генерации».
const PDF_STYLES = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Times New Roman', 'PT Serif', Georgia, serif; font-size: 12pt; line-height: 1.5; color: #000; overflow-wrap: break-word; }
  h1 { font-size: 18pt; font-weight: bold; margin: 12pt 0 6pt; }
  h2 { font-size: 16pt; font-weight: bold; margin: 10pt 0 5pt; }
  h3 { font-size: 14pt; font-weight: bold; margin: 8pt 0 4pt; }
  h4, h5, h6 { font-size: 12pt; font-weight: bold; margin: 6pt 0 3pt; }
  p { margin: 0 0 6pt; }
  table { width: 100%; border-collapse: collapse; margin: 8pt 0; font-size: 11pt; }
  th, td { border: 1px solid #333; padding: 4pt 6pt; text-align: left; vertical-align: top; }
  th { background-color: #f0f0f0; font-weight: bold; }
  ul, ol { margin: 4pt 0 4pt 20pt; }
  li { margin-bottom: 2pt; }
  img { max-width: 100%; height: auto; }
  blockquote { border-left: 3px solid #ccc; padding-left: 10pt; margin: 6pt 0; color: #333; }
  strong, b { font-weight: bold; }
  em, i { font-style: italic; }
`;

function previewPage(bodyHtml: string): string {
  // A4-ширина листа (210mm ≈ 794px @96dpi), внутренние поля как «лист бумаги»
  // на сером фоне — так контент видно в превью-панели.
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"/>
<style>
  html, body { margin:0; padding:0; background:#e5e7eb; }
  ${PREVIEW_STYLES}
  .sheet { width: 794px; margin: 0 auto; background:#fff; padding: 48px 56px; box-shadow: 0 1px 4px rgba(0,0,0,.15); }
</style></head>
<body><div class="sheet gen-preview-html">${bodyHtml}</div></body></html>`;
}

function pdfViewPage(bodyHtml: string): string {
  // Имитация A4-страницы с теми же полями, что в page.pdf (top/bottom 20mm,
  // left/right 15mm). 210mm=794px, поля 15mm≈57px / 20mm≈76px @96dpi.
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"/>
<style>
  html, body { margin:0; padding:0; background:#9ca3af; }
  ${PDF_STYLES}
  .page { width: 794px; min-height: 1123px; margin: 0 auto; background:#fff; padding: 76px 57px; box-shadow: 0 1px 6px rgba(0,0,0,.3); }
</style></head>
<body><div class="page">${bodyHtml}</div></body></html>`;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const entries = await readdir(SRC_DIR);
  const docxFiles = entries
    .filter((f) => f.toLowerCase().endsWith('.docx') && !f.startsWith('~$'))
    .sort();

  console.log(`Найдено шаблонов: ${docxFiles.length}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const report: Array<{
    file: string;
    htmlLen: number;
    messages: string[];
    tables: number;
    images: number;
    pdfBytes: number;
    error?: string;
  }> = [];

  let idx = 0;
  for (const file of docxFiles) {
    idx += 1;
    const base = `${String(idx).padStart(2, '0')}_${file.replace(/\.docx$/i, '')}`;
    const safeBase = base.replace(/[\/\\:*?"<>|]/g, '_');
    const row: (typeof report)[number] = {
      file,
      htmlLen: 0,
      messages: [],
      tables: 0,
      images: 0,
      pdfBytes: 0,
    };
    try {
      const buf = await readFile(path.join(SRC_DIR, file));
      const { html, messages } = await parseDocxToHtml(buf);
      row.htmlLen = html.length;
      row.messages = messages;
      row.tables = (html.match(/<table/gi) ?? []).length;
      row.images = (html.match(/<img/gi) ?? []).length;

      // Сохраним сырой HTML для отладки
      await writeFile(path.join(OUT_DIR, `${safeBase}.html`), html, 'utf8');

      // --- Реальный PDF («после генерации») ---
      const pdf = await buildPdfFromHtml(html, { title: file.replace(/\.docx$/i, '') });
      row.pdfBytes = pdf.length;
      await writeFile(path.join(OUT_DIR, `${safeBase}.pdf`), pdf);

      // --- Скриншот «до генерации» (preview) ---
      const pPrev = await browser.newPage();
      await pPrev.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });
      await pPrev.setContent(previewPage(html), { waitUntil: 'networkidle0', timeout: 20_000 });
      await pPrev.screenshot({
        path: path.join(OUT_DIR, `${safeBase}__1_before.png`) as `${string}.png`,
        fullPage: true,
      });
      await pPrev.close();

      // --- Скриншот «после генерации» (pdf-вид) ---
      const pPdf = await browser.newPage();
      await pPdf.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });
      await pPdf.emulateMediaType('print');
      await pPdf.setContent(pdfViewPage(html), { waitUntil: 'networkidle0', timeout: 20_000 });
      await pPdf.screenshot({
        path: path.join(OUT_DIR, `${safeBase}__2_after.png`) as `${string}.png`,
        fullPage: true,
      });
      await pPdf.close();

      console.log(
        `✓ ${file} — html ${row.htmlLen}b, таблиц ${row.tables}, картинок ${row.images}, pdf ${(row.pdfBytes / 1024).toFixed(0)}KB`,
      );
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err);
      console.log(`✗ ${file} — ОШИБКА: ${row.error}`);
    }
    report.push(row);
  }

  await browser.close();
  await closePdfBrowser();

  await writeFile(path.join(OUT_DIR, '_report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('\nГотово. Результаты в', OUT_DIR);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
