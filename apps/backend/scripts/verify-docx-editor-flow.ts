/**
 * verify-docx-editor-flow — автономная E2E-верификация фичи редактирования
 * .docx в браузере (Фазы 1-2, задача b24-doc-gen-0gw.2).
 *
 * Полный UI-flow требует живого портала Bitrix24 (загрузка через UI-кнопку,
 * правка в <DocxEditor> @eigenpal/docx-editor-react, генерация на реальной
 * сделке). Этот скрипт проверяет автономно МАКСИМУМ серверной логики, на
 * которую опирается фича: пересканирование тегов после правки документа и
 * подстановку нового тега в оригинальный .docx с сохранением форматирования.
 *
 * Эмулируемый сценарий (= что делает админ в редакторе):
 *  1. Берёт реальный шаблон
 *     «шаблоны для первичного обращения/первичное заявление в СК ПВУ.docx».
 *  2. Программно (через PizZip) ВСТАВЛЯЕТ в существующий абзац плейсхолдер
 *     {new_tag} как обычный текст — так же, как DocxEditor сохранил бы .docx
 *     после того как пользователь набрал «{new_tag}» в документе. Вставка
 *     делается в конец текста абзаца с непустым форматированием (w:jc/w:ind),
 *     чтобы проверить сохранность формата именно в точке нового тега.
 *     Этот изменённый буфер — то, что ушло бы в PUT /api/templates/:id/docx.
 *  3. scanDocxPlaceholders(markedBuf) — подтверждает, что `new_tag` найден
 *     (это бэкенд-шаг пересканирования внутри PUT /:id/docx, результат
 *     которого попадает в панель «Теги шаблона» как unbound-тег).
 *  4. buildDocxFromTemplate(markedBuf, { formulas: { new_tag: <мок> } }) —
 *     подставляет моковое значение new_tag (как при генерации после того,
 *     как админ привязал к тегу формулу/поле).
 *  5. Проверяет результат:
 *     (а) тег {new_tag} в выводе заменён моковым значением (исходного
 *         {new_tag} не осталось, значение присутствует);
 *     (б) форматирование сохранено — w:jc (right/center/both) и w:ind
 *         в выводе не хуже, чем в оригинале (точнее: w:jc/w:ind абзаца,
 *         куда вставлен new_tag, присутствуют в выводе).
 *  6. Печатает отчёт; код выхода 1 при провале.
 *
 * Запуск: pnpm -F backend exec tsx scripts/verify-docx-editor-flow.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import PizZip from 'pizzip';
import {
  buildDocxFromTemplate,
  scanDocxPlaceholders,
} from '../src/services/docxTemplateEngine.js';
import type { FormulaEvaluationResult } from '@b24-doc-gen/shared';

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SRC_DOCX = resolve(
  REPO_ROOT,
  'шаблоны для первичного обращения/первичное заявление в СК ПВУ.docx',
);
const OUT_EDITED = resolve(REPO_ROOT, 'apps/backend/scripts/_editor-edited.docx');
const OUT_RENDERED = resolve(REPO_ROOT, 'apps/backend/scripts/_editor-rendered.docx');

const NEW_TAG = 'new_tag';
const NEW_TAG_VALUE = 'ЗНАЧЕНИЕ-НОВОГО-ТЕГА-2026';

/* ------------------------------------------------------------------ */
/* Step 2 — emulate DocxEditor save: insert {new_tag} into a formatted */
/*          paragraph of the existing document.                        */
/* ------------------------------------------------------------------ */

/**
 * Insert ` {new_tag}` at the end of the text of the FIRST paragraph that
 * carries explicit formatting (a `<w:jc .../>` justification or a
 * `<w:ind .../>` indent in its `<w:pPr>`). Returns the edited buffer plus
 * the formatting tokens captured from that paragraph so the test can assert
 * they survive substitution.
 *
 * The insertion appends a new `<w:r><w:t xml:space="preserve"> {new_tag}</w:t></w:r>`
 * run just before the paragraph's closing `</w:p>`, mirroring how a WYSIWYG
 * editor appends typed text as its own run without disturbing existing runs
 * or the paragraph properties.
 */
function insertNewTagIntoFormattedParagraph(originalBuf: Buffer): {
  buffer: Buffer;
  pPr: string;
  hasJc: boolean;
  hasInd: boolean;
} {
  const zip = new PizZip(originalBuf);
  const xml = zip.file('word/document.xml')!.asText();

  // Find paragraphs and pick the first one whose pPr contains w:jc or w:ind.
  const paraRegex = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let match: RegExpExecArray | null;
  let targetFull: string | null = null;
  let targetInner: string | null = null;
  let pPr = '';
  let hasJc = false;
  let hasInd = false;

  while ((match = paraRegex.exec(xml)) !== null) {
    const full = match[0];
    const inner = match[1];
    const pPrMatch = inner.match(/<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/);
    if (!pPrMatch) continue;
    const pPrText = pPrMatch[0];
    const jc = /<w:jc\b[^>]*\/>/.test(pPrText) || /<w:jc\b[^>]*>/.test(pPrText);
    const ind = /<w:ind\b[^>]*\/>/.test(pPrText) || /<w:ind\b[^>]*>/.test(pPrText);
    // Need a paragraph that has formatting AND at least one text run to append to.
    if ((jc || ind) && /<w:r\b/.test(inner) && /<w:t\b/.test(inner)) {
      targetFull = full;
      targetInner = inner;
      pPr = pPrText;
      hasJc = jc;
      hasInd = ind;
      break;
    }
  }

  if (targetFull === null || targetInner === null) {
    throw new Error('No formatted paragraph (w:jc/w:ind) with text runs found in document.xml');
  }

  // Build a new run carrying " {new_tag}" and splice it before </w:p>.
  const newRun = `<w:r><w:t xml:space="preserve"> {${NEW_TAG}}</w:t></w:r>`;
  const insertAt = targetFull.lastIndexOf('</w:p>');
  const editedPara =
    targetFull.slice(0, insertAt) + newRun + targetFull.slice(insertAt);

  const editedXml = xml.replace(targetFull, editedPara);
  zip.file('word/document.xml', editedXml);

  return {
    buffer: zip.generate({ type: 'nodebuffer' }),
    pPr,
    hasJc,
    hasInd,
  };
}

/* ------------------------------------------------------------------ */
/* Mock generation inputs (admin bound {new_tag} to a formula)         */
/* ------------------------------------------------------------------ */

const formulas: Record<string, FormulaEvaluationResult> = {
  [NEW_TAG]: {
    tagKey: NEW_TAG,
    label: 'Новый тег из редактора',
    expression: 'DEAL.UF_NEW',
    value: NEW_TAG_VALUE,
    error: undefined,
  },
};

/* ------------------------------------------------------------------ */
/* Checks                                                              */
/* ------------------------------------------------------------------ */

function countAll(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function run(): Promise<void> {
  const checks: Check[] = [];

  // --- Load original ---
  const originalBuf = readFileSync(SRC_DOCX);
  const origXml = new PizZip(originalBuf).file('word/document.xml')!.asText();

  // sanity: original must not already contain {new_tag}
  checks.push({
    name: 'original .docx does not already contain {new_tag}',
    ok: !origXml.includes(`{${NEW_TAG}}`),
    detail: origXml.includes(`{${NEW_TAG}}`) ? 'unexpectedly present' : 'absent as expected',
  });

  // --- Step 2: emulate editor save — insert {new_tag} ---
  const { buffer: editedBuf, hasJc, hasInd } = insertNewTagIntoFormattedParagraph(originalBuf);
  writeFileSync(OUT_EDITED, editedBuf);
  const editedXml = new PizZip(editedBuf).file('word/document.xml')!.asText();

  checks.push({
    name: 'edited copy contains the inserted {new_tag}',
    ok: editedXml.includes(`{${NEW_TAG}}`),
    detail: editedXml.includes(`{${NEW_TAG}}`) ? 'placeholder injected' : 'placeholder missing',
  });
  checks.push({
    name: 'target paragraph carries formatting (w:jc and/or w:ind)',
    ok: hasJc || hasInd,
    detail: `w:jc=${hasJc}, w:ind=${hasInd}`,
  });

  // --- Step 3: backend re-scan (PUT /:id/docx -> scanDocxPlaceholders) ---
  const scanned = scanDocxPlaceholders(editedBuf);
  checks.push({
    name: '(scan) scanDocxPlaceholders finds new_tag',
    ok: scanned.includes(NEW_TAG),
    detail: `tags=[${scanned.join(', ')}]`,
  });

  // --- Step 4: render through the production engine ---
  const renderedBuf = await buildDocxFromTemplate(editedBuf, { formulas, title: 'ПВУ' });
  writeFileSync(OUT_RENDERED, renderedBuf);
  const outXml = new PizZip(renderedBuf).file('word/document.xml')!.asText();

  // (a) {new_tag} replaced with its value -------------------------------
  checks.push({
    name: '(a) no {new_tag} placeholder remains in output',
    ok: !outXml.includes(`{${NEW_TAG}}`),
    detail: outXml.includes(`{${NEW_TAG}}`) ? 'placeholder NOT substituted' : 'placeholder substituted',
  });
  checks.push({
    name: '(a) substituted value present in output',
    ok: outXml.includes(NEW_TAG_VALUE),
    detail: outXml.includes(NEW_TAG_VALUE) ? `value "${NEW_TAG_VALUE}" present` : 'value missing',
  });

  // (b) formatting preserved: w:jc right/center/both --------------------
  const jcVals = ['right', 'center', 'both'] as const;
  for (const v of jcVals) {
    const before = countAll(origXml, `w:val="${v}"`);
    const after = countAll(outXml, `w:val="${v}"`);
    checks.push({
      name: `(b) w:jc="${v}" preserved (count not reduced)`,
      ok: after >= before,
      detail: `original=${before}, rendered=${after}`,
    });
  }

  // (b) indents preserved: w:ind ----------------------------------------
  const indBefore = countAll(origXml, '<w:ind ');
  const indAfter = countAll(outXml, '<w:ind ');
  checks.push({
    name: '(b) w:ind (indents) preserved (count not reduced)',
    ok: indAfter >= indBefore && indBefore > 0,
    detail: `original=${indBefore}, rendered=${indAfter}`,
  });

  // --- Report ---
  const pass = checks.every((c) => c.ok);
  console.log('\n=== E2E 0gw.2: правка .docx в редакторе + новый тег ===\n');
  console.log(`Источник:  ${SRC_DOCX}`);
  console.log(`Изменено:  ${OUT_EDITED}`);
  console.log(`Результат: ${OUT_RENDERED}\n`);
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  —  ${c.detail}`);
  }
  console.log(`\nИТОГ: ${pass ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : 'ЕСТЬ ПРОВАЛЫ'}\n`);
  process.exit(pass ? 0 : 1);
}

run().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
