/**
 * Unit tests for the quick-fields history helpers (FormulaBuilder
 * "часто используемые поля" palette).
 *
 * A tiny in-memory `localStorage` stub is installed so the persistence
 * helpers run under Node. Runner: `node:test` via tsx.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_QUICK_FIELDS,
  QUICK_FIELDS_MAX,
  QUICK_FIELDS_STORAGE_KEY,
  loadRecentFields,
  mergeQuickFields,
  addRecentField,
  saveRecentFields,
  type QuickField,
} from './quickFields.js';

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

/* --------------------------- mergeQuickFields ------------------- */

test('mergeQuickFields with empty history returns the defaults', () => {
  assert.deepEqual(mergeQuickFields([]), DEFAULT_QUICK_FIELDS);
});

test('mergeQuickFields promotes recent and dedups against defaults', () => {
  const recent: QuickField[] = [{ token: 'DEAL.TITLE', label: 'Своя метка' }];
  const merged = mergeQuickFields(recent);
  // Recent entry is first and keeps its custom label…
  assert.deepEqual(merged[0], { token: 'DEAL.TITLE', label: 'Своя метка' });
  // …and DEAL.TITLE is not repeated from the defaults.
  assert.equal(merged.filter((f) => f.token === 'DEAL.TITLE').length, 1);
});

test('mergeQuickFields caps the list at QUICK_FIELDS_MAX', () => {
  const recent: QuickField[] = Array.from({ length: 25 }, (_, i) => ({
    token: `DEAL.F${i}`,
    label: `F${i}`,
  }));
  const merged = mergeQuickFields(recent);
  assert.equal(merged.length, QUICK_FIELDS_MAX);
});

/* ---------------------------- addRecentField -------------------- */

test('addRecentField moves an existing token to the front', () => {
  const start: QuickField[] = [
    { token: 'A', label: 'a' },
    { token: 'B', label: 'b' },
  ];
  const next = addRecentField(start, 'B', 'b2');
  assert.deepEqual(next, [
    { token: 'B', label: 'b2' },
    { token: 'A', label: 'a' },
  ]);
  assert.equal(next.length, 2, 'no duplicate B');
});

test('addRecentField prepends a new token and caps at the max', () => {
  const start: QuickField[] = Array.from({ length: QUICK_FIELDS_MAX }, (_, i) => ({
    token: `T${i}`,
    label: `t${i}`,
  }));
  const next = addRecentField(start, 'NEW', 'new');
  assert.equal(next.length, QUICK_FIELDS_MAX);
  assert.equal(next[0].token, 'NEW');
  // The oldest entry fell off the end.
  assert.equal(next.some((f) => f.token === `T${QUICK_FIELDS_MAX - 1}`), false);
});

/* ------------------------- load / save -------------------------- */

test('save → load round-trips the history', () => {
  const list: QuickField[] = [{ token: 'DEAL.TITLE', label: 'Название' }];
  saveRecentFields(list);
  assert.deepEqual(loadRecentFields(), list);
});

test('loadRecentFields tolerates corrupt JSON', () => {
  store.set(QUICK_FIELDS_STORAGE_KEY, '{not json');
  assert.deepEqual(loadRecentFields(), []);
});

test('loadRecentFields ignores a non-array payload', () => {
  store.set(QUICK_FIELDS_STORAGE_KEY, JSON.stringify({ token: 'x' }));
  assert.deepEqual(loadRecentFields(), []);
});

test('loadRecentFields filters out malformed entries', () => {
  store.set(
    QUICK_FIELDS_STORAGE_KEY,
    JSON.stringify([
      { token: 'OK', label: 'ok' },
      { token: 123, label: 'bad-token' },
      { label: 'no-token' },
      null,
      'string',
    ]),
  );
  assert.deepEqual(loadRecentFields(), [{ token: 'OK', label: 'ok' }]);
});

test('loadRecentFields returns [] when storage is empty', () => {
  assert.deepEqual(loadRecentFields(), []);
});
