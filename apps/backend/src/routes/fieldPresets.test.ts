/**
 * Unit tests for the field-preset route normalizers (`__test`).
 *
 * These cover the validation/sanitization boundary of
 * `routes/fieldPresets.ts` without spinning up Fastify: name bounds,
 * value-mode coercion, option cleaning, JSON (de)serialization and the
 * row→DTO mapping — including corrupt/edge inputs.
 *
 * Runner: Node's built-in `node:test` (executed via tsx).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test } from './fieldPresets.js';

const { normalizeName, normalizeValueMode, normalizeOrder, normalizeOptions, parseOptions, toPresetDto } =
  __test;

/* ----------------------------- name ----------------------------- */

test('normalizeName trims and rejects empty / oversized', () => {
  assert.equal(normalizeName('  Страховые  '), 'Страховые');
  assert.equal(normalizeName(''), null);
  assert.equal(normalizeName('   '), null);
  assert.equal(normalizeName(123), null);
  assert.equal(normalizeName('x'.repeat(201)), null);
  assert.equal(normalizeName('x'.repeat(200)), 'x'.repeat(200));
});

/* --------------------------- valueMode -------------------------- */

test('normalizeValueMode only accepts "mapped", else "direct"', () => {
  assert.equal(normalizeValueMode('mapped'), 'mapped');
  assert.equal(normalizeValueMode('direct'), 'direct');
  assert.equal(normalizeValueMode('garbage'), 'direct');
  assert.equal(normalizeValueMode(undefined), 'direct');
  assert.equal(normalizeValueMode(null), 'direct');
});

/* ----------------------------- order ---------------------------- */

test('normalizeOrder truncates numbers and falls back', () => {
  assert.equal(normalizeOrder(3.9), 3);
  assert.equal(normalizeOrder('5'), 5);
  assert.equal(normalizeOrder('abc', 7), 7);
  assert.equal(normalizeOrder(undefined, 0), 0);
});

/* --------------------------- options ---------------------------- */

test('normalizeOptions trims, drops empty labels, keeps value', () => {
  const out = normalizeOptions([
    { label: '  A  ', value: '  1  ' },
    { label: '', value: 'x' }, // dropped: empty label
    { label: 'B' }, // value defaults to ''
    { label: 'C', value: 42 }, // value coerced to string
  ]);
  assert.deepEqual(out, [
    { label: 'A', value: '1' },
    { label: 'B', value: '' },
    { label: 'C', value: '42' },
  ]);
});

test('normalizeOptions tolerates non-array / junk entries', () => {
  assert.deepEqual(normalizeOptions(undefined), []);
  assert.deepEqual(normalizeOptions('nope'), []);
  assert.deepEqual(normalizeOptions([null, 5, 'str', {}]), []);
});

test('parseOptions round-trips valid JSON and survives corruption', () => {
  assert.deepEqual(parseOptions(JSON.stringify([{ label: 'A', value: '1' }])), [
    { label: 'A', value: '1' },
  ]);
  assert.deepEqual(parseOptions('{not json'), []);
  assert.deepEqual(parseOptions('null'), []);
  assert.deepEqual(parseOptions('42'), []);
});

/* ----------------------------- DTO ------------------------------ */

test('toPresetDto maps a row and parses its options + dates', () => {
  const dto = toPresetDto({
    id: 'abc',
    name: 'Список',
    valueMode: 'mapped',
    options: JSON.stringify([{ label: 'A', value: '1' }]),
    order: 2,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-02-02T00:00:00.000Z'),
  });
  assert.equal(dto.id, 'abc');
  assert.equal(dto.name, 'Список');
  assert.equal(dto.valueMode, 'mapped');
  assert.deepEqual(dto.options, [{ label: 'A', value: '1' }]);
  assert.equal(dto.order, 2);
  assert.equal(dto.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(dto.updatedAt, '2026-02-02T00:00:00.000Z');
});

test('toPresetDto coerces an unknown valueMode to "direct"', () => {
  const dto = toPresetDto({
    id: 'x',
    name: 'n',
    valueMode: 'weird',
    options: '[]',
    order: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  assert.equal(dto.valueMode, 'direct');
  assert.deepEqual(dto.options, []);
});
