/**
 * <OAuthSync/> — invisible mount-once component that forwards the
 * current BX24 SDK auth snapshot to the backend, so the server can
 * keep a long-lived refresh_token on file for server-to-server flows
 * (most notably the webhook executor at /api/webhook/run/:token).
 *
 * Why it exists:
 *   - The webhook executor has no live iframe session to pull tokens
 *     from. It relies on `AppSettings.refreshToken` captured at
 *     install time.
 *   - If the app was installed before this feature existed, or if the
 *     stored refresh_token aged out of the window, we'd lose the
 *     ability to call REST on behalf of the portal.
 *   - Mounting this component on every app open ensures the stored
 *     tokens are always at most one session old — as long as an admin
 *     opens the app occasionally, webhooks keep working.
 *
 * Gating:
 *   - Only admins sync, because `/api/install/sync-oauth` is gated by
 *     the normal B24 auth middleware and verifies that
 *     `oauth.memberId === auth.memberId`. A non-admin sync would
 *     still work, but there is no value in spamming the endpoint from
 *     every regular user, so we skip it.
 *   - Fires only once per mount (guarded by a ref) and only after the
 *     role query has resolved.
 *   - Failures are logged to console but never surfaced to the user —
 *     this is a best-effort background sync, not a blocking flow.
 */

import { useEffect, useRef } from 'react';
import { useCurrentRole } from '@/lib/useCurrentRole';
import { getB24Auth } from '@/lib/b24';
import { installApi } from '@/lib/api';

export function OAuthSync(): null {
  const { isAdmin, isLoading } = useCurrentRole();
  const doneRef = useRef(false);

  useEffect(() => {
    if (doneRef.current) return;
    if (isLoading) return;
    if (!isAdmin) return;

    const sdk = getB24Auth();
    if (!sdk) return;

    doneRef.current = true;

    installApi
      .syncOAuth({
        oauth: {
          accessToken: sdk.accessToken,
          refreshToken: sdk.refreshToken,
          expiresAt: sdk.expiresAt,
          memberId: sdk.memberId,
          domain: sdk.domain,
        },
      })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('OAuthSync: sync-oauth failed (non-fatal):', err);
      });
  }, [isAdmin, isLoading]);

  return null;
}
