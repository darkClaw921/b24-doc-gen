/**
 * `<AdminOnly>` — render children only when the current user has the
 * `admin` role. Useful for hiding mutation buttons (Upload template,
 * Edit, Create theme, …) from regular users.
 *
 * Backed by `useCurrentRole()` (which queries `GET /api/me`). While
 * the role is still loading, the wrapper renders nothing — same as
 * the non-admin case — to avoid a brief flash of admin UI.
 *
 * Optional `fallback` prop renders a placeholder (e.g. a tooltip
 * or a disabled button) when the user is not an admin.
 */

import type { ReactNode } from 'react';
import { useCurrentRole } from '@/lib/useCurrentRole';

interface AdminOnlyProps {
  children: ReactNode;
  fallback?: ReactNode;
}

export function AdminOnly({ children, fallback = null }: AdminOnlyProps): JSX.Element {
  const { isAdmin, isLoading } = useCurrentRole();
  if (isLoading || !isAdmin) {
    return <>{fallback}</>;
  }
  return <>{children}</>;
}
