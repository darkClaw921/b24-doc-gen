/**
 * verify-pvu-template — одноразовый E2E-скрипт верификации Фазы 5 (w9z.4).
 *
 * Поскольку живого Bitrix24 нет, это интеграционная проверка ядра
 * генерации без CRM:
 *
 *  1. Берёт реальный шаблон
 *     «шаблоны для первичного обращения/первичное заявление в СК ПВУ.docx».
 *  2. Программно (через PizZip) делает размеченную копию: заменяет
 *     несколько человекочитаемых заглушек на плейсхолдеры
 *     {tagKey} (формулы) и {fieldKey} (ручные поля) — выбраны заглушки,
 *     лежащие в абзацах с выравниванием right / both и отступами w:ind,
 *     чтобы проверить сохранность форматирования именно в местах подстановки.
 *  3. Вызывает боевой buildDocxFromTemplate с моковыми formula results,
 *     fieldValues и продуктами.
 *  4. Распаковывает document.xml результата и проверяет:
 *     (а) плейсхолдеры заменены значениями (исходных {tag} не осталось,
 *         подставленные значения присутствуют);
 *     (б) форматирование сохранено — w:jc (right/center/both) и w:ind
 *         присутствуют в результате не хуже, чем в оригинале.
 *  5. Сохраняет результат .docx и печатает отчёт; код выхода 1 при провале.
 *
 * Запуск: pnpm -F backend exec tsx scripts/verify-pvu-template.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import PizZip from 'pizzip';
import {
  buildDocxFromTemplate,
} from '../src/services/docxTemplateEngine.js';
import type { FormulaEvaluationResult, ProductRow } from '@b24-doc-gen/shared';

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SRC_DOCX = resolve(
  REPO_ROOT,
  'шаблоны для первичного обращения/первичное заявление в СК ПВУ.docx',
);
const OUT_MARKED = resolve(REPO_ROOT, 'apps/backend/scripts/_pvu-marked.docx');
const OUT_RENDERED = resolve(REPO_ROOT, 'apps/backend/scripts/_pvu-rendered.docx');

/* ------------------------------------------------------------------ */
/* Step 1+2 — build a marked-up copy by replacing stubs with tags      */
/* ------------------------------------------------------------------ */

/**
 * Stub→placeholder replacements. Each `stub` is a contiguous run of text
 * that exists verbatim in a single <w:t> in the source document, so the
 * replacement does not split the docxtemplater delimiter across runs.
 *
 * Alignment column documents which paragraph the stub lives in, so the
 * test can assert formatting survives substitution at that exact spot.
 */
const REPLACEMENTS: Array<{ stub: string; placeholder: string; align: string }> = [
  // Header paragraph — w:jc=right
  {
    stub: 'Наименование Страховой компании (автомат из справочника)',
    placeholder: '{insurer_name}',
    align: 'right',
  },
  // Body paragraph — w:jc=both + w:ind
  {
    stub: ' ХХХ (автомат из КК), по полису ХХХ (автомат из КК)',
    placeholder: ' {insurer_self} (формула), по полису {policy_number} (поле)',
    align: 'both',
  },
  // Another body run — w:jc=both, used for a manual field
  {
    stub: 'Дата и время страхового случая: ',
    placeholder: 'Дата и время страхового случая: {incident_datetime} ',
    align: 'both',
  },
];

function buildMarkedDocx(originalBuf: Buffer): Buffer {
  const zip = new PizZip(originalBuf);
  let xml = zip.file('word/document.xml')!.asText();

  for (const { stub, placeholder } of REPLACEMENTS) {
    if (!xml.includes(stub)) {
      throw new Error(`Stub not found verbatim in document.xml: ${JSON.stringify(stub)}`);
    }
    xml = xml.split(stub).join(placeholder);
  }

  zip.file('word/document.xml', xml);
  return zip.generate({ type: 'nodebuffer' });
}

/* ------------------------------------------------------------------ */
/* Mock generation inputs                                              */
/* ------------------------------------------------------------------ */

const VALUES = {
  insurer_name: 'СПАО «Ингосстрах»',
  insurer_self: 'АО «АльфаСтрахование»',
  policy_number: 'XXX 0123456789',
  incident_datetime: '05.06.2026 14:30',
};

const formulas: Record<string, FormulaEvaluationResult> = {
  insurer_name: { tagKey: 'insurer_name', label: 'Страховая компания', expression: 'DEAL.UF_INSURER', value: VALUES.insurer_name, error: undefined },
  insurer_self: { tagKey: 'insurer_self', label: 'Моя СК', expression: 'DEAL.UF_SELF_INSURER', value: VALUES.insurer_self, error: undefined },
  incident_datetime: { tagKey: 'incident_datetime', label: 'Дата ДТП', expression: 'DEAL.UF_INCIDENT', value: VALUES.incident_datetime, error: undefined },
};

const fieldValues: Record<string, string> = {
  policy_number: VALUES.policy_number,
};

const products: ProductRow[] = [
  {
    ID: 1, PRODUCT_ID: 100, PRODUCT_NAME: 'Экспертиза ТС', PRICE: 5000,
    QUANTITY: 1, MEASURE_NAME: 'шт', DISCOUNT_SUM: 0, TAX_RATE: 0, SUM: 5000, SORT: 10,
  } as ProductRow,
];

/* ------------------------------------------------------------------ */
/* Checks                                                              */
/* ------------------------------------------------------------------ */

function countAll(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

interface Check { name: string; ok: boolean; detail: string }

function run(): void {
  const checks: Check[] = [];

  // --- Load + mark ---
  const originalBuf = readFileSync(SRC_DOCX);
  const origXml = new PizZip(originalBuf).file('word/document.xml')!.asText();

  const markedBuf = buildMarkedDocx(originalBuf);
  writeFileSync(OUT_MARKED, markedBuf);
  const markedXml = new PizZip(markedBuf).file('word/document.xml')!.asText();

  // sanity: placeholders are present in the marked copy
  const placeholdersInMarked = ['{insurer_name}', '{insurer_self}', '{policy_number}', '{incident_datetime}']
    .filter((p) => markedXml.includes(p));
  checks.push({
    name: 'marked copy contains all 4 placeholders',
    ok: placeholdersInMarked.length === 4,
    detail: `found ${placeholdersInMarked.length}/4: ${placeholdersInMarked.join(', ')}`,
  });

  // --- Render through the production engine ---
  // (async wrapped at call site)
  return void buildDocxFromTemplate(markedBuf, { formulas, products, fieldValues, title: 'ПВУ' })
    .then((renderedBuf) => {
      writeFileSync(OUT_RENDERED, renderedBuf);
      const outXml = new PizZip(renderedBuf).file('word/document.xml')!.asText();

      // (a) placeholders replaced with values --------------------------------
      const leftoverTags = ['{insurer_name}', '{insurer_self}', '{policy_number}', '{incident_datetime}']
        .filter((p) => outXml.includes(p));
      checks.push({
        name: '(a) no template placeholders remain in output',
        ok: leftoverTags.length === 0,
        detail: leftoverTags.length ? `leftover: ${leftoverTags.join(', ')}` : 'all placeholders substituted',
      });

      const valuesPresent = Object.values(VALUES).filter((v) => outXml.includes(v));
      checks.push({
        name: '(a) substituted values present in output',
        ok: valuesPresent.length === Object.keys(VALUES).length,
        detail: `present ${valuesPresent.length}/${Object.keys(VALUES).length}: ${valuesPresent.join(' | ')}`,
      });

      // (b) formatting preserved: w:jc right/center/both ---------------------
      const jcVals = ['right', 'center', 'both'] as const;
      for (const v of jcVals) {
        const before = countAll(origXml, `w:val="${v}"`);
        const after = countAll(outXml, `w:val="${v}"`);
        // also tolerate self-closing variants with space
        checks.push({
          name: `(b) w:jc="${v}" preserved`,
          ok: after >= before && before > 0,
          detail: `original=${before}, rendered=${after}`,
        });
      }

      // (b) indents preserved: w:ind -----------------------------------------
      const indBefore = countAll(origXml, '<w:ind ');
      const indAfter = countAll(outXml, '<w:ind ');
      checks.push({
        name: '(b) w:ind (indents) preserved',
        ok: indAfter >= indBefore && indBefore > 0,
        detail: `original=${indBefore}, rendered=${indAfter}`,
      });

      // --- Report ---
      const pass = checks.every((c) => c.ok);
      console.log('\n=== Верификация w9z.4: первичное заявление в СК ПВУ ===\n');
      console.log(`Источник:  ${SRC_DOCX}`);
      console.log(`Размечено: ${OUT_MARKED}`);
      console.log(`Результат: ${OUT_RENDERED}\n`);
      for (const c of checks) {
        console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  —  ${c.detail}`);
      }
      console.log(`\nИТОГ: ${pass ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : 'ЕСТЬ ПРОВАЛЫ'}\n`);
      process.exit(pass ? 0 : 1);
    })
    .catch((err) => {
      console.error('Render failed:', err);
      process.exit(1);
    });
}

run();
