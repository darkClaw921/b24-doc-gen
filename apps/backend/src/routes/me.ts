/**
 * "Who am I" route — returns the resolved Bitrix24 user id and the
 * application role (admin / user) for the current request.
 *
 * Used by the frontend `useCurrentRole` hook to decide which UI
 * elements to render. Always cheap: a single look-up against the
 * cached AppSettings.adminUserIds list.
 */

import type { FastifyInstance } from 'fastify';
import type { AppRole } from '@b24-doc-gen/shared';
import { loadCurrentRole } from '../middleware/role.js';

export interface MeResponse {
  userId: number;
  role: AppRole;
}

export async function registerMeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/me', async (request, reply): Promise<MeResponse | void> => {
    const auth = request.b24Auth;
    if (!auth) return reply.unauthorized('B24 auth payload missing');

    const role = await loadCurrentRole(request);
    return {
      userId: Number.isFinite(auth.userId) ? auth.userId : 0,
      role,
    };
  });
}
