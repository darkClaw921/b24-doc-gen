/**
 * Unit tests for `formulaEngine.evaluateExpression` / `validateExpression`.
 *
 * Regression focus: a formula that does arithmetic on an entity field
 * which is **absent or null** in the scope (e.g. `DEAL.OPPORTUNITY * 2`
 * against an empty `DEAL`) must NOT throw the mathjs error
 * "Unexpected type of argument in function multiplyScalar
 * (… actual: identifier | undefined …)". Missing/null fields default to
 * `''`, which mathjs coerces to `0` in arithmetic, so the formula
 * evaluates cleanly — and `validateExpression` (which trial-runs against
 * empty stubs) no longer reports a valid formula as broken.
 *
 * Genuine type errors (`"abc" * 2`) must still surface.
 *
 * Runner: Node's built-in `node:test` (executed via tsx). Run with:
 *   pnpm -F backend exec tsx --test src/services/formulaEngine.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExpression, validateExpression } from './formulaEngine.js';

test('arithmetic on a missing entity field does not throw (defaults to 0)', () => {
  const r = evaluateExpression('DEAL.OPPORTUNITY * 2', { DEAL: {} });
  assert.equal(r.error, undefined);
  assert.equal(r.raw, 0);
  assert.equal(r.value, '0');
});

test('arithmetic on a null entity field defaults to 0', () => {
  const r = evaluateExpression('DEAL.OPPORTUNITY * 2', { DEAL: { OPPORTUNITY: null } });
  assert.equal(r.error, undefined);
  assert.equal(r.raw, 0);
});

test('present numeric / string fields still compute correctly', () => {
  assert.equal(evaluateExpression('DEAL.OPPORTUNITY * 2', { DEAL: { OPPORTUNITY: 1000 } }).raw, 2000);
  assert.equal(evaluateExpression('DEAL.OPPORTUNITY * 2', { DEAL: { OPPORTUNITY: '1000.00' } }).raw, 2000);
});

test('text concat with a missing field yields empty for that field', () => {
  const r = evaluateExpression('concat(DEAL.TITLE, "!")', { DEAL: {} });
  assert.equal(r.error, undefined);
  assert.equal(r.value, '!');
});

test('a genuine type error (non-numeric string * number) still surfaces', () => {
  const r = evaluateExpression('DEAL.TITLE * 2', { DEAL: { TITLE: 'abc' } });
  assert.ok(r.error, 'expected an error for "abc" * 2');
});

test('validateExpression accepts arithmetic on entity fields', () => {
  const v = validateExpression('DEAL.OPPORTUNITY * 2');
  assert.equal(v.ok, true);
  assert.deepEqual(v.deps?.deal, ['OPPORTUNITY']);
});
