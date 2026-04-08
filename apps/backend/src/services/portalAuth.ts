/**
 * Portal OAuth helper — manages the long-lived access/refresh token
 * pair stored in AppSettings so that server-to-server callers (most
 * notably the webhook executor at routes/webhookRun.ts) can talk to
 * Bitrix24 REST without a live iframe session.
 *
 * Flow:
 *   1. During installation the frontend forwards the full SDK auth
 *      payload (access_token, refresh_token, expires, member_id,
 *      domain) to POST /api/install. The install route persists it
 *      into AppSettings via `savePortalTokens()`.
 *   2. When the webhook executor needs to call REST, it asks
 *      `getFreshPortalAuth()` for a guaranteed-valid access token. If
 *      the stored token has expired (or will expire within 60s) the
 *      helper calls Bitrix's OAuth refresh endpoint, persists the new
 *      pair, and returns the refreshed token.
 *   3. Bitrix's OAuth refresh endpoint lives at
 *      `https://oauth.bitrix.info/oauth/token/`. It requires the
 *      application's client_id and client_secret — configured via the
 *      B24_CLIENT_ID / B24_CLIENT_SECRET env vars. These come from the
 *      local application manifest in the portal admin UI (the "Код"
 *      and "Ключ" fields).
 *
 * The stored row is `AppSettings { id: 1 }`. There is no per-user
 * token storage — a single portal install has a single bot identity
 * (the admin who installed the app), which matches how Bitrix24
 * bizproc robots authenticate callbacks.
 */

import type { AppSettings as PrismaAppSettings } from '@prisma/client';
import { prisma } from '../prisma/client.js';
import { decryptToken, encryptToken } from './tokenCrypto.js';

/** Refresh endpoint documented at https://apidocs.bitrix24.com/api-reference/oauth/ */
const OAUTH_REFRESH_ENDPOINT = 'https://oauth.bitrix.info/oauth/token/';

/** Refresh the token when it has less than this many seconds left. */
const REFRESH_SKEW_SECONDS = 60;

export interface PortalAuth {
  accessToken: string;
  domain: string;
  memberId: string;
}

export class PortalAuthError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | 'not_installed'
      | 'missing_tokens'
      | 'missing_client_credentials'
      | 'refresh_failed',
  ) {
    super(message);
    this.name = 'PortalAuthError';
  }
}

/**
 * Persist a fresh set of portal OAuth tokens into AppSettings. Called
 * from the install route when the frontend forwards its SDK auth
 * payload, and from `refreshPortalTokens()` after a successful refresh.
 *
 * Uses upsert so it works both during the very first install (when
 * AppSettings doesn't exist yet) and on subsequent reinstalls. The
 * `portalDomain` field is kept in sync with the forwarded `domain`.
 */
export async function savePortalTokens(input: {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  memberId: string;
  domain: string;
  applicationToken?: string | null;
}): Promise<void> {
  // Tokens are stored encrypted at rest (AES-256-GCM via tokenCrypto).
  // encryptToken() is idempotent, so callers may hand us either fresh
  // plaintext from Bitrix or an already-encrypted value without issue.
  const baseData = {
    accessToken: encryptToken(input.accessToken),
    refreshToken: encryptToken(input.refreshToken),
    authExpiresAt: input.expiresAt,
    memberId: input.memberId,
    portalDomain: input.domain,
    ...(input.applicationToken
      ? { applicationToken: encryptToken(input.applicationToken) }
      : {}),
  };

  await prisma.appSettings.upsert({
    where: { id: 1 },
    update: baseData,
    create: {
      id: 1,
      adminUserIds: '[]',
      ...baseData,
    },
  });
}

/**
 * Returns a guaranteed-valid access token for the installed portal.
 * If the stored token is still good, returns it directly. Otherwise
 * calls the Bitrix OAuth refresh endpoint, persists the new pair, and
 * returns the fresh token.
 *
 * Throws `PortalAuthError` on any unrecoverable failure so callers can
 * map it to a clean HTTP response.
 */
export async function getFreshPortalAuth(): Promise<PortalAuth> {
  const row = await prisma.appSettings.findUnique({ where: { id: 1 } });
  if (!row) {
    throw new PortalAuthError(
      'AppSettings row is missing — the application has not been installed yet',
      'not_installed',
    );
  }
  if (!row.accessToken || !row.refreshToken || !row.authExpiresAt || !row.memberId) {
    throw new PortalAuthError(
      'Portal OAuth tokens are not stored — re-open the app in the portal to re-capture them',
      'missing_tokens',
    );
  }

  const nowMs = Date.now();
  const expiresMs = row.authExpiresAt.getTime();
  const stillFresh = expiresMs - nowMs > REFRESH_SKEW_SECONDS * 1000;

  if (stillFresh) {
    // decryptToken is tolerant of legacy plaintext rows — if the row
    // predates encryption it comes through untouched.
    const plainAccess = decryptToken(row.accessToken);
    if (!plainAccess) {
      throw new PortalAuthError(
        'Stored access token is empty after decryption',
        'missing_tokens',
      );
    }
    return {
      accessToken: plainAccess,
      domain: row.portalDomain,
      memberId: row.memberId,
    };
  }

  return refreshPortalTokens(row);
}

/**
 * Force a token refresh against Bitrix's OAuth endpoint. Exported so
 * the webhook executor can retry once if a first call returns
 * `expired_token` (rare — expiresAt should catch this, but clock skew
 * happens).
 */
export async function refreshPortalTokens(row: PrismaAppSettings): Promise<PortalAuth> {
  const clientId = process.env.B24_CLIENT_ID;
  const clientSecret = process.env.B24_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new PortalAuthError(
      'B24_CLIENT_ID / B24_CLIENT_SECRET are not configured — set them in apps/backend/.env',
      'missing_client_credentials',
    );
  }
  if (!row.refreshToken) {
    throw new PortalAuthError(
      'Cannot refresh: refreshToken is null',
      'missing_tokens',
    );
  }

  const plainRefresh = decryptToken(row.refreshToken);
  if (!plainRefresh) {
    throw new PortalAuthError(
      'Cannot refresh: stored refreshToken is empty after decryption',
      'missing_tokens',
    );
  }

  const url =
    `${OAUTH_REFRESH_ENDPOINT}?` +
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: plainRefresh,
    }).toString();

  let resp: Response;
  try {
    resp = await fetch(url, { method: 'GET' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PortalAuthError(`OAuth refresh network error: ${msg}`, 'refresh_failed');
  }

  const text = await resp.text();
  if (!resp.ok) {
    throw new PortalAuthError(
      `OAuth refresh failed: HTTP ${resp.status} ${text.slice(0, 500)}`,
      'refresh_failed',
    );
  }

  interface RefreshResponse {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    expires?: number;
    domain?: string;
    member_id?: string;
    error?: string;
    error_description?: string;
  }

  let parsed: RefreshResponse;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PortalAuthError(
      `OAuth refresh returned non-JSON: ${text.slice(0, 500)}`,
      'refresh_failed',
    );
  }
  if (parsed.error) {
    throw new PortalAuthError(
      `OAuth refresh error: ${parsed.error}${parsed.error_description ? ` — ${parsed.error_description}` : ''}`,
      'refresh_failed',
    );
  }
  if (!parsed.access_token || !parsed.refresh_token) {
    throw new PortalAuthError(
      'OAuth refresh response missing access_token / refresh_token',
      'refresh_failed',
    );
  }

  // Bitrix returns either `expires_in` (seconds relative) or `expires`
  // (absolute unix seconds). Prefer absolute when available.
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAtSec =
    typeof parsed.expires === 'number' && parsed.expires > 0
      ? parsed.expires
      : nowSec + (typeof parsed.expires_in === 'number' ? parsed.expires_in : 3600);

  const newAuth = {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: new Date(expiresAtSec * 1000),
    memberId: parsed.member_id ?? row.memberId ?? '',
    domain: parsed.domain ?? row.portalDomain,
  };

  await savePortalTokens(newAuth);

  return {
    accessToken: newAuth.accessToken,
    domain: newAuth.domain,
    memberId: newAuth.memberId,
  };
}
