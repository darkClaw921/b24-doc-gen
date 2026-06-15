/**
 * Unit tests for `getDealContext` ASSIGNED resolution — the deal's
 * responsible user (`ASSIGNED_BY_ID`) is fetched via `user.get` in the
 * stage-2 batch and exposed as the flat `ASSIGNED` entity.
 *
 * A fake `fetchImpl` answers the two `batch` round-trips by inspecting
 * the `cmd` map. Edge cases:
 *  - a deal with a responsible user → ASSIGNED populated (users[0]);
 *  - a deal with ASSIGNED_BY_ID = 0 → no user.get, ASSIGNED = {};
 *  - user.get returning an empty array → ASSIGNED = {}.
 *
 * Runner: Node's built-in `node:test` (executed via tsx).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { B24Client } from './b24Client.js';
import { getDealContext } from './dealData.js';

/** Build a fetch-like Response around a batch envelope. */
function batchEnvelope(result: Record<string, unknown>): Response {
  return {
    status: 200,
    json: async () => ({ result: { result, result_error: {} } }),
  } as unknown as Response;
}

/**
 * Fake fetch that routes the two batch calls by the `cmd` keys present
 * in the request body. `stage1` answers the deal+contacts batch;
 * `stage2` answers the contact/company/assigned batch.
 */
function dealFetch(
  stage1: Record<string, unknown>,
  stage2: Record<string, unknown>,
): typeof fetch {
  return (async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}');
    const cmd = (body.cmd ?? {}) as Record<string, string>;
    if ('deal' in cmd) return batchEnvelope(stage1);
    return batchEnvelope(stage2);
  }) as unknown as typeof fetch;
}

function makeClient(
  stage1: Record<string, unknown>,
  stage2: Record<string, unknown>,
): B24Client {
  return new B24Client({
    portal: 'example.bitrix24.ru',
    accessToken: 'tok',
    fetchImpl: dealFetch(stage1, stage2),
  });
}

test('responsible user is resolved into ASSIGNED', async () => {
  const client = makeClient(
    { deal: { ID: 1, ASSIGNED_BY_ID: 7, COMPANY_ID: 0 }, contacts: [] },
    {
      assigned: [
        { ID: 7, NAME: 'Иван', LAST_NAME: 'Петров', WORK_POSITION: 'Менеджер' },
      ],
    },
  );

  const ctx = await getDealContext(client, 1);
  assert.equal(ctx.ASSIGNED.NAME, 'Иван');
  assert.equal(ctx.ASSIGNED.LAST_NAME, 'Петров');
  assert.equal(ctx.ASSIGNED.WORK_POSITION, 'Менеджер');
});

test('deal without a responsible user yields empty ASSIGNED', async () => {
  const client = makeClient(
    { deal: { ID: 2, ASSIGNED_BY_ID: 0, COMPANY_ID: 0 }, contacts: [] },
    {}, // stage-2 never asked for `assigned`
  );

  const ctx = await getDealContext(client, 2);
  assert.deepEqual(ctx.ASSIGNED, {});
});

test('user.get returning no rows yields empty ASSIGNED', async () => {
  const client = makeClient(
    { deal: { ID: 3, ASSIGNED_BY_ID: 999, COMPANY_ID: 0 }, contacts: [] },
    { assigned: [] },
  );

  const ctx = await getDealContext(client, 3);
  assert.deepEqual(ctx.ASSIGNED, {});
});
