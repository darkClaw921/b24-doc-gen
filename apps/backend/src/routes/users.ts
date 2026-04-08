/**
 * REST-proxy endpoint for portal users.
 *
 *  - `GET /api/users?search=...&start=...` — searches portal users via
 *    `user.get`. Used by the InstallPage admin picker.
 *
 * Bitrix24's `user.get` accepts:
 *   - `FILTER` — `{ NAME: 'Ivan', LAST_NAME: '...' , ACTIVE: true }`
 *   - `sort`/`order`/`start` for pagination
 *
 * We accept a single `search` query parameter for the common case
 * "search by partial name". The frontend can pass it from a debounced
 * input. Returns a normalised array of `{ id, name, lastName, email }`
 * objects so the InstallPage UI does not need to know the raw shape.
 */

import type { FastifyInstance } from 'fastify';
import { B24Client, B24Error } from '../services/b24Client.js';

interface UsersQuery {
  search?: string;
  start?: string;
}

/** Public shape returned to the frontend. */
export interface PortalUser {
  id: number;
  name: string;
  lastName: string;
  fullName: string;
  email: string;
  active: boolean;
}

export async function registerUsersRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: UsersQuery }>('/api/users', async (request, reply) => {
    const auth = request.b24Auth;
    if (!auth) return reply.unauthorized('B24 auth payload missing');

    const { search, start } = request.query;
    const filter: Record<string, unknown> = { ACTIVE: true };
    if (search && search.trim().length > 0) {
      // Bitrix24 supports % wildcards in user.get filters.
      filter.NAME = `%${search.trim()}%`;
    }

    const client = new B24Client({
      portal: auth.domain,
      accessToken: auth.accessToken,
    });

    const params: Record<string, unknown> = { FILTER: filter, SORT: 'LAST_NAME', ORDER: 'ASC' };
    const startNum = Number(start ?? 0);
    if (Number.isFinite(startNum) && startNum > 0) params.start = startNum;

    try {
      const raw = await client.listUsers(params);
      const users: PortalUser[] = raw.map(toPortalUser);
      return { users, count: users.length };
    } catch (err) {
      if (err instanceof B24Error) {
        const wrapped = new Error(`${err.code}: ${err.message}`);
        (wrapped as Error & { statusCode: number }).statusCode = err.status > 0 ? err.status : 502;
        throw wrapped;
      }
      throw err;
    }
  });
}

function toPortalUser(row: Record<string, unknown>): PortalUser {
  const id = Number(row.ID ?? row.id ?? 0);
  const name = String(row.NAME ?? row.name ?? '');
  const lastName = String(row.LAST_NAME ?? row.last_name ?? '');
  const email = String(row.EMAIL ?? row.email ?? '');
  return {
    id,
    name,
    lastName,
    fullName: [name, lastName].filter(Boolean).join(' ').trim() || `User #${id}`,
    email,
    active: row.ACTIVE === true || row.ACTIVE === 'true' || row.ACTIVE === 'Y',
  };
}
