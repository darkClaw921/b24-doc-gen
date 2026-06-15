/**
 * Unit tests for `B24Client.getUserFields` — the responsible-user field
 * schema (`ASSIGNED.*`) that merges `user.fields` (standard fields) with
 * `user.userfield.list` (user-defined `UF_USR_*` fields).
 *
 * A fake `fetchImpl` routes by method name in the REST URL so no network
 * is touched. Edge cases covered:
 *  - standard fields mapped with a neutral `string` type;
 *  - UF fields carry their real type / multiplicity / enum items;
 *  - the UF call failing (e.g. missing scope) degrades gracefully to the
 *    standard fields only;
 *  - a UF code that also appears in `user.fields` is not duplicated.
 *
 * Runner: Node's built-in `node:test` (executed via tsx).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { B24Client } from './b24Client.js';

/** Build a minimal fetch-like Response wrapper around an envelope. */
function envelope(body: unknown): Response {
  return {
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

interface Routes {
  userFields: unknown;
  userFieldList: unknown | (() => unknown);
}

/** A fake fetch that dispatches on the method segment of the REST URL. */
function fakeFetch(routes: Routes): typeof fetch {
  return (async (url: string) => {
    if (url.includes('/rest/user.fields')) {
      return envelope({ result: routes.userFields });
    }
    if (url.includes('/rest/user.userfield.list')) {
      const r =
        typeof routes.userFieldList === 'function'
          ? (routes.userFieldList as () => unknown)()
          : routes.userFieldList;
      return envelope(r);
    }
    throw new Error(`unexpected url: ${url}`);
  }) as unknown as typeof fetch;
}

function makeClient(routes: Routes): B24Client {
  return new B24Client({
    portal: 'example.bitrix24.ru',
    accessToken: 'tok',
    fetchImpl: fakeFetch(routes),
  });
}

test('merges standard fields (string type) with UF fields (real type)', async () => {
  const client = makeClient({
    userFields: { NAME: 'Имя', LAST_NAME: 'Фамилия', WORK_POSITION: 'Должность' },
    userFieldList: {
      result: [
        {
          FIELD_NAME: 'UF_USR_DEPT',
          USER_TYPE_ID: 'enumeration',
          EDIT_FORM_LABEL: { ru: 'Отдел' },
          MULTIPLE: 'Y',
          MANDATORY: 'N',
          LIST: [
            { ID: '10', VALUE: 'Продажи' },
            { ID: '11', VALUE: 'Логистика' },
          ],
        },
        {
          FIELD_NAME: 'UF_USR_MONEY',
          USER_TYPE_ID: 'money',
          MULTIPLE: 'N',
          MANDATORY: 'Y',
        },
      ],
    },
  });

  const fields = await client.getUserFields();
  const byCode = new Map(fields.map((f) => [f.code, f]));

  // Standard fields → string type.
  assert.equal(byCode.get('NAME')?.title, 'Имя');
  assert.equal(byCode.get('NAME')?.type, 'string');
  assert.equal(byCode.get('WORK_POSITION')?.title, 'Должность');

  // UF enumeration: rich metadata + items.
  const dept = byCode.get('UF_USR_DEPT');
  assert.ok(dept, 'UF_USR_DEPT present');
  assert.equal(dept?.title, 'Отдел');
  assert.equal(dept?.type, 'enumeration');
  assert.equal(dept?.isUserField, true);
  assert.equal(dept?.isMultiple, true);
  assert.equal(dept?.isRequired, false);
  assert.deepEqual(dept?.items, [
    { id: '10', value: 'Продажи' },
    { id: '11', value: 'Логистика' },
  ]);

  // UF money: title falls back to FIELD_NAME, mandatory flag.
  const money = byCode.get('UF_USR_MONEY');
  assert.equal(money?.title, 'UF_USR_MONEY');
  assert.equal(money?.type, 'money');
  assert.equal(money?.isRequired, true);
  assert.equal(money?.isMultiple, false);
});

test('UF call failure degrades to standard fields only', async () => {
  const client = makeClient({
    userFields: { NAME: 'Имя', EMAIL: 'E-Mail' },
    // Simulate "insufficient scope" — callMethod throws, listUserUserFields swallows.
    userFieldList: { error: 'insufficient_scope', error_description: 'no scope' },
  });

  const fields = await client.getUserFields();
  const codes = fields.map((f) => f.code).sort();
  assert.deepEqual(codes, ['EMAIL', 'NAME']);
  assert.ok(fields.every((f) => f.type === 'string'));
});

test('a UF code appearing in user.fields is not duplicated', async () => {
  const client = makeClient({
    // user.fields unexpectedly also lists the UF technical code.
    userFields: { NAME: 'Имя', UF_USR_DEPT: 'UF_USR_DEPT' },
    userFieldList: {
      result: [
        { FIELD_NAME: 'UF_USR_DEPT', USER_TYPE_ID: 'string', MULTIPLE: 'N', MANDATORY: 'N' },
      ],
    },
  });

  const fields = await client.getUserFields();
  const deptEntries = fields.filter((f) => f.code === 'UF_USR_DEPT');
  assert.equal(deptEntries.length, 1, 'UF_USR_DEPT appears exactly once');
  // The rich UF version wins (isUserField set), not the string stub.
  assert.equal(deptEntries[0].isUserField, true);
});

test('empty userfield list returns just the standard fields', async () => {
  const client = makeClient({
    userFields: { NAME: 'Имя' },
    userFieldList: { result: [] },
  });
  const fields = await client.getUserFields();
  assert.deepEqual(
    fields.map((f) => f.code),
    ['NAME'],
  );
});
