/**
 * Unit tests for the pure select-option helpers.
 *
 * Runner: Node's built-in `node:test` (executed via tsx). The module has
 * only a type-only import, so it loads cleanly outside the Vite bundle.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBulkOptions, mergeParsedOptions } from './selectOptions.js';

test('direct mode keeps each whole line, preserving double spaces', () => {
  assert.deepEqual(parseBulkOptions('Вариант A\nООО  Ромашка', false), [
    { label: 'Вариант A', value: '' },
    { label: 'ООО  Ромашка', value: '' },
  ]);
});

test('mapped mode splits label/value on a tab or 2+ spaces', () => {
  assert.deepEqual(
    parseBulkOptions('Росгосстрах\t600020 г.Владимир\nИнгосстрах   101000 Москва', true),
    [
      { label: 'Росгосстрах', value: '600020 г.Владимир' },
      { label: 'Ингосстрах', value: '101000 Москва' },
    ],
  );
});

test('mapped line without a separator becomes label-only', () => {
  assert.deepEqual(parseBulkOptions('ТолькоНазвание', true), [
    { label: 'ТолькоНазвание', value: '' },
  ]);
});

test('blank lines and surrounding whitespace are ignored', () => {
  assert.deepEqual(parseBulkOptions('\n  A  \n\n  B \n', false), [
    { label: 'A', value: '' },
    { label: 'B', value: '' },
  ]);
});

test('empty input yields no options', () => {
  assert.deepEqual(parseBulkOptions('', false), []);
  assert.deepEqual(parseBulkOptions('   \n  ', true), []);
});

test('mergeParsedOptions dedups by label and drops empty placeholders', () => {
  const existing = [
    { label: '', value: '' }, // placeholder row → dropped
    { label: 'A', value: '1' },
  ];
  const parsed = [
    { label: 'A', value: 'dup' }, // duplicate label → ignored
    { label: 'B', value: '2' },
  ];
  assert.deepEqual(mergeParsedOptions(existing, parsed), [
    { label: 'A', value: '1' },
    { label: 'B', value: '2' },
  ]);
});
