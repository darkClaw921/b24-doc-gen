/**
 * `useCurrentRole` — TanStack Query wrapper around `GET /api/me`.
 *
 * Returns the resolved Bitrix24 user id and the application role
 * ('admin' / 'user'). The query is cached forever for the session
 * (staleTime: Infinity) because the role only changes when an admin
 * edits the AppSettings list — and at that point we explicitly
 * invalidate the query.
 *
 * The hook also exposes a few convenience flags so call-sites don't
 * have to repeat `data?.role === 'admin'`:
 *
 *   const { isAdmin, isLoading, userId } = useCurrentRole();
 *
 * Components that should hide entire blocks for non-admins should use
 * the `<AdminOnly>` wrapper from `components/AdminOnly.tsx` instead of
 * threading the flag manually.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { meApi, type MeDTO } from './api';
import { isB24Available } from './b24';

export const ME_QUERY_KEY = ['me'] as const;

export interface UseCurrentRoleResult {
  data?: MeDTO;
  userId: number;
  role: 'admin' | 'user';
  isAdmin: boolean;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
}

export function useCurrentRole(): UseCurrentRoleResult {
  const query = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: ({ signal }) => meApi.get(signal),
    enabled: isB24Available(),
    staleTime: Infinity,
    retry: 0,
  });

  const role: 'admin' | 'user' = query.data?.role ?? 'user';

  return {
    data: query.data,
    userId: query.data?.userId ?? 0,
    role,
    isAdmin: role === 'admin',
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}

/**
 * Helper hook returning a function that invalidates the cached `me`
 * query — call after any mutation that may have changed the admin
 * list (e.g. SettingsPage save).
 */
export function useInvalidateRole(): () => Promise<void> {
  const qc = useQueryClient();
  return async () => {
    await qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
  };
}
