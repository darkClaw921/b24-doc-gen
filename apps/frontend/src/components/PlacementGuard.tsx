/**
 * PlacementGuard — wraps the application's authenticated routes and
 * enforces three preconditions before children are rendered:
 *
 *   1. The Bitrix24 SDK initialized (`isB24Available()` is true).
 *      If not, render an "open me from Bitrix24" stub.
 *
 *   2. The application has been installed (`GET /api/install/status`
 *      returns `installed: true`). If not, redirect to `/install`
 *      (unless we're already there).
 *
 *   3. (Optional) The current placement matches an expected value.
 *      Used by the deal-detail tab to refuse to render generic
 *      management pages.
 *
 * The guard reads the placement code from the SDK on mount, looks at
 * the URL `?view=` query parameter to allow a one-shot redirect into
 * a specific page, and then renders its children.
 */

import { useEffect, type ReactNode } from 'react';
import { useLocation, useNavigate, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { isB24Available, getCurrentPlacement } from '@/lib/b24';
import { installApi } from '@/lib/api';
import { useCurrentRole } from '@/lib/useCurrentRole';

/** Maps the `?view=...` query param to a router path. */
const VIEW_TO_PATH: Record<string, string> = {
  generate: '/generate',
  settings: '/settings',
  templates: '/templates',
  install: '/install',
};

/** Maps a Bitrix24 placement code to a default landing path. */
function defaultPathForPlacement(placement: string): string {
  switch (placement) {
    case 'CRM_DEAL_DETAIL_TAB':
      return '/generate';
    case 'DEFAULT':
      return '/templates';
    default:
      return '/templates';
  }
}

interface PlacementGuardProps {
  children: ReactNode;
}

export function PlacementGuard({ children }: PlacementGuardProps): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();

  const statusQuery = useQuery({
    queryKey: ['install', 'status'],
    queryFn: () => installApi.status(),
    enabled: isB24Available(),
    retry: 0,
  });

  // Resolve the current role so we can refuse to render the settings
  // page (and the rest of the admin UI) for non-admins. The query is
  // only enabled once we know the app is installed — otherwise the
  // backend would just return 401 because there is no AppSettings row.
  const installed = statusQuery.data?.installed ?? false;
  const roleQuery = useCurrentRole();

  /**
   * On first render after the SDK is up, route by `?view=` query
   * param. This lets us register a single iframe handler URL with
   * Bitrix24 and dispatch to the right React Router path on the
   * client side.
   */
  useEffect(() => {
    if (!isB24Available()) return;
    const params = new URLSearchParams(location.search);
    const view = params.get('view');
    if (view && VIEW_TO_PATH[view] && location.pathname !== VIEW_TO_PATH[view]) {
      navigate(VIEW_TO_PATH[view], { replace: true });
      return;
    }
    // If we're at the bare root, route by placement.
    if (location.pathname === '/' || location.pathname === '') {
      navigate(defaultPathForPlacement(getCurrentPlacement()), { replace: true });
    }
  }, [location.pathname, location.search, navigate]);

  if (!isB24Available()) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="text-2xl font-semibold">Откройте приложение из Bitrix24</h1>
        <p className="mt-3 text-muted-foreground">
          Эта страница работает только внутри iframe Bitrix24. Установите
          приложение в свой портал и откройте его через карточку сделки
          (вкладка «Документы») или общий пункт меню.
        </p>
      </div>
    );
  }

  if (statusQuery.isLoading) {
    return (
      <div className="mx-auto max-w-2xl p-8 text-muted-foreground">
        Загрузка состояния приложения…
      </div>
    );
  }

  if (statusQuery.error) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="text-2xl font-semibold">Ошибка</h1>
        <p className="mt-2 text-destructive">
          Не удалось получить статус приложения: {(statusQuery.error as Error).message}
        </p>
      </div>
    );
  }

  // Not installed → bounce to install page (unless already there).
  if (statusQuery.data && !statusQuery.data.installed && location.pathname !== '/install') {
    return <Navigate to="/install" replace />;
  }

  // Admin-only routes:
  //   - /settings (any placement) — settings UI is admin-only.
  //   - /templates and the editor — admin shaping; but the rendering
  //     gracefully degrades for users (read-only) so we don't redirect.
  //
  // The DEFAULT placement (top-menu / generic landing) renders the
  // settings page first, and if the current user is not an admin we
  // show a 403 stub instead of bouncing — they should NOT see the
  // settings UI at all.
  if (installed && !roleQuery.isLoading) {
    const isSettingsPath = location.pathname.startsWith('/settings');
    const placement = getCurrentPlacement();
    const isDefaultPlacementSettings = placement === 'DEFAULT' && isSettingsPath;
    if ((isSettingsPath || isDefaultPlacementSettings) && !roleQuery.isAdmin) {
      return (
        <div className="mx-auto max-w-2xl p-8">
          <h1 className="text-2xl font-semibold">403 — Доступ запрещён</h1>
          <p className="mt-3 text-muted-foreground">
            Раздел настроек доступен только администраторам приложения. Если
            это ошибка — попросите администратора добавить вас в список в
            настройках.
          </p>
        </div>
      );
    }
  }

  return <>{children}</>;
}
