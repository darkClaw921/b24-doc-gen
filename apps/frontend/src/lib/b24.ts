/**
 * Bitrix24 SDK bootstrap and helpers for the frontend (iframe mode).
 *
 * The application runs as a local Bitrix24 application embedded in an
 * iframe. We use `@bitrix24/b24jssdk`'s `initializeB24Frame` to obtain
 * a `B24Frame` instance which gives us:
 *
 *  - access to the auth payload (access_token, member_id, domain),
 *  - the current placement code and its options (e.g. the deal ID),
 *  - a typed REST client (`callMethod`, `callBatch`).
 *
 * The frame is initialized lazily once and cached in module scope so
 * components can call `getB24()` synchronously after `initB24()` has
 * resolved in `main.tsx`.
 *
 * When the app is opened outside of a Bitrix24 iframe (for example
 * during local development on http://localhost:5173 directly), the
 * SDK will time out. We expose `isB24Available()` so callers can show
 * an informative fallback instead of crashing.
 */

import { initializeB24Frame, type B24Frame } from '@bitrix24/b24jssdk';

/** Auth payload extracted from the iframe SDK. */
export interface B24FrontendAuth {
  /** Bitrix24 access token used by REST methods. */
  accessToken: string;
  /** Refresh token returned by the SDK. */
  refreshToken: string;
  /** Unix seconds at which the access token expires. */
  expiresAt: number;
  /** Bitrix24 portal domain, e.g. "example.bitrix24.ru". */
  domain: string;
  /** Stable per-portal member id. */
  memberId: string;
  /** OAuth scope granted to the application. */
  scope?: string;
}

let frameInstance: B24Frame | null = null;
let initPromise: Promise<B24Frame> | null = null;
let initFailed: Error | null = null;

/**
 * Initialize the Bitrix24 frame SDK. Idempotent — repeated calls share
 * the same in-flight promise. Returns the initialized `B24Frame` so
 * callers may use it directly, but the recommended pattern is to call
 * this once at app startup and then use `getB24()` from components.
 *
 * If the SDK fails to initialize (most likely because the page is not
 * embedded in a Bitrix24 portal), the error is captured in
 * `initFailed` and re-thrown — the caller is expected to render a
 * fallback UI based on `isB24Available()`.
 */
export async function initB24(): Promise<B24Frame> {
  if (frameInstance) return frameInstance;
  if (initPromise) return initPromise;

  initPromise = initializeB24Frame()
    .then((frame) => {
      frameInstance = frame;
      initFailed = null;
      return frame;
    })
    .catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      initFailed = error;
      initPromise = null;
      throw error;
    });

  return initPromise;
}

/**
 * Returns the cached `B24Frame` instance. Throws if `initB24()` has
 * not been awaited yet, so the caller is forced to handle ordering.
 */
export function getB24(): B24Frame {
  if (!frameInstance) {
    throw new Error(
      'Bitrix24 SDK is not initialized. Call initB24() before getB24().',
    );
  }
  return frameInstance;
}

/**
 * Returns true if the SDK initialized successfully and the app is
 * running inside a Bitrix24 iframe. Used by route guards to render
 * a "this app must be opened from Bitrix24" stub.
 */
export function isB24Available(): boolean {
  return frameInstance !== null;
}

/**
 * If `initB24()` failed, return the captured error. Otherwise null.
 * Useful for showing the underlying reason in the fallback UI.
 */
export function getB24InitError(): Error | null {
  return initFailed;
}

/**
 * Returns the current authentication payload from the SDK, or `null`
 * if the frame is not initialized or the token has expired.
 *
 * The auth manager exposes `getAuthData()` which returns `false` when
 * the token has expired; we normalize that to `null` for ergonomic
 * `if (!auth) return ...` checks.
 */
export function getB24Auth(): B24FrontendAuth | null {
  if (!frameInstance) return null;

  const data = frameInstance.auth.getAuthData();
  if (data === false) return null;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires,
    domain: data.domain,
    memberId: data.member_id,
    scope: data.scope,
  };
}

/**
 * Forces the SDK to refresh its access token using the parent window
 * and returns the fresh payload. Wrap this in a try/catch — the SDK
 * will reject if the user has logged out of the portal.
 */
export async function refreshB24Auth(): Promise<B24FrontendAuth> {
  const frame = getB24();
  const fresh = await frame.auth.refreshAuth();
  return {
    accessToken: fresh.access_token,
    refreshToken: fresh.refresh_token,
    expiresAt: fresh.expires,
    domain: fresh.domain,
    memberId: fresh.member_id,
    scope: fresh.scope,
  };
}

/**
 * Returns the Bitrix24 user ID for the current iframe session. The
 * SDK exposes user identity through the auth payload's `member_id`
 * (per portal) and a separate `userId` accessor on the placement
 * info — for our purposes we read it from `frame.auth` if available
 * and fall back to placement options.
 */
export function getCurrentUserId(): number | null {
  if (!frameInstance) return null;
  // The SDK does not expose a stable typed `userId` on the auth
  // payload, so we read it from placement options when present —
  // Bitrix24 always injects USER_ID in iframe handler URLs.
  const placementOptions = getPlacementOptions();
  const fromPlacement = Number(placementOptions['USER_ID'] ?? NaN);
  if (Number.isFinite(fromPlacement) && fromPlacement > 0) {
    return fromPlacement;
  }
  // Fall back to the `auth.userId` if the SDK exposes it (newer
  // versions add this field). Use a permissive cast to avoid a
  // hard typing dependency on a particular SDK release.
  const auth = frameInstance.auth as unknown as { userId?: number };
  return typeof auth.userId === 'number' ? auth.userId : null;
}

/**
 * Returns the deal ID extracted from the placement options, or null
 * if the current placement does not provide one.
 *
 * The CRM_DEAL_DETAIL_TAB placement injects an `ID` option holding
 * the deal id; CRM_DEAL_LIST_TOOLBAR uses `entityTypeId`/selection.
 * For other placements this returns null.
 */
export function getCurrentDealId(): number | null {
  const opts = getPlacementOptions();
  const candidates = [opts['ID'], opts['DEAL_ID'], opts['ENTITY_ID']];
  for (const raw of candidates) {
    const num = Number(raw ?? NaN);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return null;
}

/**
 * Returns the current placement code (e.g. "CRM_DEAL_DETAIL_TAB",
 * "DEFAULT") or "DEFAULT" if the SDK is not initialized.
 */
export function getCurrentPlacement(): string {
  if (!frameInstance) return 'DEFAULT';
  try {
    return frameInstance.placement.placement || 'DEFAULT';
  } catch {
    return 'DEFAULT';
  }
}

/**
 * Returns a shallow copy of the placement options object as a
 * Record<string, unknown>. The SDK freezes the underlying object,
 * so we never mutate it.
 */
export function getPlacementOptions(): Record<string, unknown> {
  if (!frameInstance) return {};
  try {
    const opts = frameInstance.placement.options;
    if (opts && typeof opts === 'object') {
      return { ...(opts as Record<string, unknown>) };
    }
  } catch {
    // ignore — return empty object
  }
  return {};
}

/**
 * Signals to Bitrix24 that the installation/setup wizard has finished.
 *
 * Per B24 docs, an app with a UI is considered NOT installed until
 * `installFinish()` is called from the install page. Until then,
 * placement bindings won't show up in the portal interface and
 * regular (non-admin) users see "ask administrator to finish install".
 *
 * Calling this on the install page reloads the iframe — Bitrix24
 * itself takes over and re-opens the app.
 */
export async function installFinishB24(): Promise<void> {
  const frame = getB24();
  // The SDK exposes installFinish() on the B24Frame instance.
  // Some SDK builds expose it on `frame` directly, others under
  // `frame.installFinish` — we accept both.
  const candidate = (frame as unknown as { installFinish?: () => Promise<void> | void }).installFinish;
  if (typeof candidate === 'function') {
    await candidate.call(frame);
    return;
  }
  // Fallback — older SDK style: try calling parent BX24 if available.
  const bx24 = (window as unknown as { BX24?: { installFinish?: () => void } }).BX24;
  if (bx24?.installFinish) {
    bx24.installFinish();
    return;
  }
  throw new Error('installFinish() is not available in the current B24 SDK');
}

/**
 * Asks Bitrix24 to refresh the deal card data after a backend mutation
 * (e.g. after generating a document and binding the file to a UF_CRM_*
 * field), so the user immediately sees the new value without F5.
 *
 * Implementation: invokes `placement.call('reloadData')` — the
 * registered interface command for the CRM_DEAL_DETAIL_TAB placement
 * that re-fetches the entity. Unlike `reloadWindow()` it does NOT
 * reload our iframe, so the result panel of GeneratePage remains
 * visible.
 *
 * Errors are swallowed: a failed reload is non-fatal, the user can
 * still refresh manually.
 */
export async function reloadParentWindow(): Promise<void> {
  if (!frameInstance) return;
  try {
    await frameInstance.placement.call('reloadData');
  } catch {
    // ignore — placement may not expose `reloadData`, user can F5
  }
}

/**
 * Builds the headers used by the backend's auth middleware. The
 * frontend sends the SDK's access_token, member_id and domain via
 * the X-B24-* headers; the middleware verifies them on every call.
 */
export function getB24AuthHeaders(): Record<string, string> {
  const auth = getB24Auth();
  if (!auth) return {};
  return {
    'X-B24-Access-Token': auth.accessToken,
    'X-B24-Member-Id': auth.memberId,
    'X-B24-Domain': auth.domain,
  };
}
