/**
 * Unit tests for the quick-formulas history helpers (FormulaBuilder
 * "часто используемые формулы" palette).
 *
 * A tiny in-memory `localStorage` stub is installed so the persistence
 * helpers run under Node. Runner: `node:test` via tsx.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_QUICK_FORMULAS,
  QUICK_FORMULAS_MAX,
  QUICK_FORMULAS_STORAGE_KEY,
  loadRecentFormulas,
  mergeQuickFormulas,
  addRecentFormula,
  saveRecentFormulas,
  type QuickFormula,
} from './quickFormulas.js';

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

/* ------------------------- mergeQuickFormulas ------------------- */

test('mergeQuickFormulas with empty history returns the defaults', () => {
  assert.deepEqual(mergeQuickFormulas([]), DEFAULT_QUICK_FORMULAS);
});

test('mergeQuickFormulas promotes recent and dedups against defaults', () => {
  const dup = DEFAULT_QUICK_FORMULAS[0];
  const recent: QuickFormula[] = [{ expression: dup.expression, label: 'Своё имя' }];
  const merged = mergeQuickFormulas(recent);
  // Recent entry is first and keeps its custom label…
  assert.deepEqual(merged[0], { expression: dup.expression, label: 'Своё имя' });
  // …and that expression is not repeated from the defaults.
  assert.equal(
    merged.filter((f) => f.expression === dup.expression).length,
    1,
  );
});

test('mergeQuickFormulas caps the list at QUICK_FORMULAS_MAX', () => {
  const recent: QuickFormula[] = Array.from({ length: 25 }, (_, i) => ({
    expression: `EXPR_${i}`,
    label: `F${i}`,
  }));
  const merged = mergeQuickFormulas(recent);
  assert.equal(merged.length, QUICK_FORMULAS_MAX);
});

/* -------------------------- addRecentFormula -------------------- */

test('addRecentFormula moves an existing expression to the front', () => {
  const start: QuickFormula[] = [
    { expression: 'A', label: 'a' },
    { expression: 'B', label: 'b' },
  ];
  const next = addRecentFormula(start, 'B', 'b2');
  assert.deepEqual(next, [
    { expression: 'B', label: 'b2' },
    { expression: 'A', label: 'a' },
  ]);
  assert.equal(next.length, 2, 'no duplicate B');
});

test('addRecentFormula prepends a new expression and caps at the max', () => {
  const start: QuickFormula[] = Array.from({ length: QUICK_FORMULAS_MAX }, (_, i) => ({
    expression: `E${i}`,
    label: `e${i}`,
  }));
  const next = addRecentFormula(start, 'NEW', 'new');
  assert.equal(next.length, QUICK_FORMULAS_MAX);
  assert.equal(next[0].expression, 'NEW');
  // The oldest entry fell off the end.
  assert.equal(next.some((f) => f.expression === `E${QUICK_FORMULAS_MAX - 1}`), false);
});

/* ------------------------- load / save -------------------------- */

test('save → load round-trips the history', () => {
  const list: QuickFormula[] = [
    { expression: 'format(DEAL.OPPORTUNITY, "money")', label: 'Сумма' },
  ];
  saveRecentFormulas(list);
  assert.deepEqual(loadRecentFormulas(), list);
});

test('loadRecentFormulas tolerates corrupt JSON', () => {
  store.set(QUICK_FORMULAS_STORAGE_KEY, '{not json');
  assert.deepEqual(loadRecentFormulas(), []);
});

test('loadRecentFormulas ignores a non-array payload', () => {
  store.set(QUICK_FORMULAS_STORAGE_KEY, JSON.stringify({ expression: 'x' }));
  assert.deepEqual(loadRecentFormulas(), []);
});

test('loadRecentFormulas filters out malformed entries', () => {
  store.set(
    QUICK_FORMULAS_STORAGE_KEY,
    JSON.stringify([
      { expression: 'OK', label: 'ok' },
      { expression: 123, label: 'bad-expr' },
      { label: 'no-expr' },
      { expression: '   ', label: 'blank-expr' },
      null,
      'string',
    ]),
  );
  assert.deepEqual(loadRecentFormulas(), [{ expression: 'OK', label: 'ok' }]);
});

test('loadRecentFormulas returns [] when storage is empty', () => {
  assert.deepEqual(loadRecentFormulas(), []);
});
