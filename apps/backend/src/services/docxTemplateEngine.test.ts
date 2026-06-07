/**
 * Unit tests for `docxTemplateEngine.buildDocxFromTemplate`.
 *
 * The tests build a minimal, self-contained .docx fixture in memory
 * (a valid OOXML ZIP assembled with PizZip — no binary asset on disk),
 * render it through `buildDocxFromTemplate`, then unzip the result and
 * assert on `word/document.xml`:
 *   - the {formulaTag} placeholder is replaced by the formula value,
 *   - the {manualField} placeholder is replaced by the manual field value,
 *   - the {#products}…{/products} loop is rendered once per product row,
 *   - the original `w:jc` / `w:ind` paragraph formatting survives.
 *
 * A negative test asserts that an empty buffer throws
 * `DocxTemplateError` with code `EMPTY_DOCX`.
 *
 * Runner: Node's built-in `node:test` (executed via tsx — the project
 * has no vitest/jest configured). Run with:
 *   pnpm -F backend exec tsx --test src/services/docxTemplateEngine.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import PizZip from 'pizzip';
import {
  buildDocxFromTemplate,
  DocxTemplateError,
} from './docxTemplateEngine.js';
import type { FormulaEvaluationResult, ProductRow } from '@b24-doc-gen/shared';

/* ------------------------------------------------------------------ */
/* Fixture helpers                                                     */
/* ------------------------------------------------------------------ */

/** Minimal `[Content_Types].xml` declaring the main document part. */
const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

/** Root relationships pointing at the main document part. */
const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

/**
 * The body of `word/document.xml`. Contains:
 *  - a paragraph with `w:jc` (centered) and `w:ind` (indented) holding
 *    the {formulaTag} and {manualField} placeholders — used to verify
 *    both substitution and formatting preservation;
 *  - a product loop paragraph `{#products}{PRODUCT_NAME} — {SUM}{/products}`.
 *
 * NB: each Word run (`<w:r><w:t>…</w:t></w:r>`) wraps a single contiguous
 * placeholder so docxtemplater can substitute it cleanly.
 */
const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr>
        <w:jc w:val="center"/>
        <w:ind w:left="720"/>
      </w:pPr>
      <w:r><w:t xml:space="preserve">Total: {formulaTag} / Note: {manualField}</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t xml:space="preserve">{#products}{PRODUCT_NAME} — {SUM}{/products}</w:t></w:r>
    </w:p>
    <w:sectPr/>
  </w:body>
</w:document>`;

/**
 * Assemble a valid in-memory .docx (OOXML ZIP) from the parts above and
 * return it as a Node Buffer suitable for `buildDocxFromTemplate`.
 */
function buildFixtureDocx(): Buffer {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES_XML);
  zip.file('_rels/.rels', ROOT_RELS_XML);
  zip.file('word/document.xml', DOCUMENT_XML);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
}

/** Read `word/document.xml` out of a rendered .docx buffer. */
function readDocumentXml(docx: Buffer): string {
  const zip = new PizZip(docx);
  const file = zip.file('word/document.xml');
  assert.ok(file, 'rendered .docx must contain word/document.xml');
  return file.asText();
}

/** Build a FormulaEvaluationResult with a successful value. */
function formula(
  tagKey: string,
  value: string,
): FormulaEvaluationResult {
  return {
    tagKey,
    label: tagKey,
    expression: `${tagKey}_expr`,
    value,
    rawValue: value,
  };
}

/** Build a minimal ProductRow with the fields the loop references. */
function product(name: string, sum: number): ProductRow {
  return {
    ID: 1,
    PRODUCT_ID: 1,
    PRODUCT_NAME: name,
    PRICE: sum,
    QUANTITY: 1,
    DISCOUNT_SUM: 0,
    TAX_RATE: 0,
    SUM: sum,
    MEASURE_NAME: 'шт',
    SORT: 100,
  } as ProductRow;
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

test('substitutes formula + manual field + product loop and preserves formatting', async () => {
  const fixture = buildFixtureDocx();

  const out = await buildDocxFromTemplate(fixture, {
    formulas: { formulaTag: formula('formulaTag', 'X') },
    fieldValues: { manualField: 'Y' },
    products: [product('A', 100), product('B', 250)],
  });

  assert.ok(Buffer.isBuffer(out), 'result is a Buffer');
  assert.ok(out.length > 0, 'result buffer is non-empty');

  const xml = readDocumentXml(out);

  // 1. Formula + manual-field placeholders are replaced by X / Y.
  assert.match(xml, /Total: X \/ Note: Y/, 'formula and manual field substituted');
  assert.ok(!xml.includes('{formulaTag}'), 'no raw {formulaTag} remains');
  assert.ok(!xml.includes('{manualField}'), 'no raw {manualField} remains');

  // 2. Product loop rendered once per row with real values.
  assert.ok(xml.includes('A — 100'), 'first product row rendered');
  assert.ok(xml.includes('B — 250'), 'second product row rendered');
  assert.ok(!xml.includes('{#products}'), 'loop opening tag consumed');
  assert.ok(!xml.includes('{/products}'), 'loop closing tag consumed');

  // 3. Formatting survives the render: w:jc / w:ind still present.
  assert.match(xml, /<w:jc w:val="center"\/>/, 'w:jc justification preserved');
  assert.match(xml, /<w:ind w:left="720"\/>/, 'w:ind indentation preserved');
});

test('formula value wins over a colliding manual field key', async () => {
  const fixture = buildFixtureDocx();

  // Same key supplied as both a formula and a manual field: the formula
  // value ("FORMULA") must win per the engine's documented precedence.
  const out = await buildDocxFromTemplate(fixture, {
    formulas: { formulaTag: formula('formulaTag', 'FORMULA') },
    fieldValues: { formulaTag: 'FIELD', manualField: 'Y' },
    products: [],
  });

  const xml = readDocumentXml(out);
  assert.ok(xml.includes('Total: FORMULA'), 'formula wins over manual field on key collision');
  assert.ok(!xml.includes('Total: FIELD'), 'manual field did not overwrite formula');
});

test('empty buffer throws DocxTemplateError(EMPTY_DOCX)', async () => {
  await assert.rejects(
    () => buildDocxFromTemplate(Buffer.alloc(0), { formulas: {} }),
    (err: unknown) => {
      assert.ok(err instanceof DocxTemplateError, 'is a DocxTemplateError');
      assert.equal(err.code, 'EMPTY_DOCX', 'code is EMPTY_DOCX');
      return true;
    },
  );
});
