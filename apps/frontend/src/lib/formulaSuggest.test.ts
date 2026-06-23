/**
 * Unit tests for the formula-suggestion helpers ("обучение по примеру":
 * запоминание шаблона строки и подбор формулы для похожей строки).
 *
 * A tiny in-memory `localStorage` stub is installed so persistence runs
 * under Node. Runner: `node:test` via tsx.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  SELECTION_MARK,
  FORMULA_MEMORY_KEY,
  FORMULA_MEMORY_MAX,
  normalizeLine,
  buildLinePattern,
  dice,
  findFormulaSuggestion,
  addFormulaMemory,
  loadFormulaMemory,
  saveFormulaMemory,
  type FormulaMemoryEntry,
} from './formulaSuggest.js';

/* ----------------------- localStorage stub ---------------------- */

function installStorage(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  return store;
}

let store: Map<string, string>;
beforeEach(() => {
  store = installStorage();
});

const deps = { deal: [], contact: [], company: [], assigned: [] };
const entry = (pattern: string, label: string): FormulaMemoryEntry => ({
  pattern,
  label,
  expression: 'DEAL.OPPORTUNITY',
  dependsOn: deps,
});

/* --------------------------- normalizeLine ---------------------- */

test('normalizeLine lowercases, collapses spaces and masks numbers', () => {
  assert.equal(normalizeLine('Итого:   1000  руб'), 'итого: # руб');
  assert.equal(normalizeLine('Сумма 1 000,50 ₽'), 'сумма # ₽');
});

test('normalizeLine masks each separate number but keeps words between', () => {
  assert.equal(normalizeLine('5 яблок 3 груши'), '# яблок # груши');
});

/* -------------------------- buildLinePattern -------------------- */

test('buildLinePattern inserts the marker at the selection', () => {
  // "Итого к оплате: " has length 16; "1000" spans [16, 20).
  const p = buildLinePattern('Итого к оплате: 1000 руб', 16, 20);
  assert.equal(p, `итого к оплате: ${SELECTION_MARK} руб`);
});

test('buildLinePattern: same template for a similar line with other digits', () => {
  const a = buildLinePattern('Итого к оплате: 1000 руб', 16, 20);
  const b = buildLinePattern('Итого к оплате: 2500 руб', 16, 20);
  assert.equal(a, b);
});

test('buildLinePattern returns null for an empty line', () => {
  assert.equal(buildLinePattern('   ', 0, 0), null);
});

/* ------------------------------- dice -------------------------- */

test('dice is 1 for identical and 0 for fully disjoint strings', () => {
  assert.equal(dice('итого', 'итого'), 1);
  assert.equal(dice('ab', 'xy'), 0);
});

test('dice is high for near-identical strings', () => {
  assert.ok(dice('итого к оплате: ⟦⟧', 'итого к оплате ⟦⟧') > 0.8);
});

/* ----------------------- findFormulaSuggestion ----------------- */

test('findFormulaSuggestion returns an exact pattern match', () => {
  const mem = [entry('итого: ⟦⟧ руб', 'Сумма'), entry('дата: ⟦⟧', 'Дата')];
  const hit = findFormulaSuggestion('итого: ⟦⟧ руб', mem);
  assert.equal(hit?.label, 'Сумма');
});

test('findFormulaSuggestion falls back to a fuzzy match above threshold', () => {
  const mem = [entry('итого к оплате: ⟦⟧ руб', 'Сумма')];
  // Slightly different (no colon) — still very similar.
  const hit = findFormulaSuggestion('итого к оплате ⟦⟧ руб', mem);
  assert.equal(hit?.label, 'Сумма');
});

test('findFormulaSuggestion returns null when nothing is similar enough', () => {
  const mem = [entry('итого к оплате: ⟦⟧ руб', 'Сумма')];
  assert.equal(findFormulaSuggestion('дата договора: ⟦⟧', mem), null);
});

test('findFormulaSuggestion returns null for a null pattern', () => {
  assert.equal(findFormulaSuggestion(null, [entry('x', 'X')]), null);
});

/* -------------------------- addFormulaMemory ------------------- */

test('addFormulaMemory dedups by pattern and moves it to the front', () => {
  const start = [entry('a', 'A'), entry('b', 'B')];
  const next = addFormulaMemory(start, entry('b', 'B2'));
  assert.equal(next.length, 2);
  assert.equal(next[0].pattern, 'b');
  assert.equal(next[0].label, 'B2');
});

test('addFormulaMemory caps the list at FORMULA_MEMORY_MAX', () => {
  let mem: FormulaMemoryEntry[] = [];
  for (let i = 0; i < FORMULA_MEMORY_MAX + 10; i++) {
    mem = addFormulaMemory(mem, entry(`p${i}`, `L${i}`));
  }
  assert.equal(mem.length, FORMULA_MEMORY_MAX);
  // Most recent first.
  assert.equal(mem[0].pattern, `p${FORMULA_MEMORY_MAX + 9}`);
});

/* ------------------------- load / save ------------------------- */

test('save → load round-trips the memory', () => {
  const mem = [entry('итого: ⟦⟧', 'Сумма')];
  saveFormulaMemory(mem);
  assert.deepEqual(loadFormulaMemory(), mem);
});

test('loadFormulaMemory tolerates corrupt JSON', () => {
  store.set(FORMULA_MEMORY_KEY, '{not json');
  assert.deepEqual(loadFormulaMemory(), []);
});

test('loadFormulaMemory filters out malformed entries', () => {
  store.set(
    FORMULA_MEMORY_KEY,
    JSON.stringify([
      { pattern: 'ok', label: 'L', expression: 'X', dependsOn: deps },
      { pattern: '', label: 'no-pattern', expression: 'X', dependsOn: deps },
      { pattern: 'no-expr', label: 'L', expression: '  ', dependsOn: deps },
      { pattern: 'no-deps', label: 'L', expression: 'X' },
      null,
      'string',
    ]),
  );
  assert.deepEqual(loadFormulaMemory(), [
    { pattern: 'ok', label: 'L', expression: 'X', dependsOn: deps },
  ]);
});
