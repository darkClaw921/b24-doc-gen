/**
 * Server-side wrapper around the Bitrix24 REST API.
 *
 * This module abstracts away the raw `https://{portal}/rest/{method}`
 * call pattern and exposes a small set of typed helpers used by the
 * route handlers and the document-generation pipeline.
 *
 * Why our own client and not `@bitrix24/b24jssdk` here:
 *  - The frontend uses `B24Frame`. The backend has the access token
 *    forwarded by the iframe, so a thin `fetch`-based client is the
 *    simplest path and avoids dragging the SDK's browser-coupled
 *    code into Node.
 *  - We want a single place to wrap errors into a typed `B24Error`
 *    so route handlers can produce consistent JSON error envelopes.
 *
 * All requests are POST `https://{portal}/rest/{method}` with the
 * payload sent as `application/json`. The auth token is appended as
 * the `auth` field in the JSON body — this is the format Bitrix24
 * accepts for REST methods invoked with an OAuth token.
 */

import type {
  AppSettings as _AppSettings,
  DealField,
} from '@b24-doc-gen/shared';

/**
 * Custom error class for Bitrix24 REST failures. Includes the
 * upstream error code, the description, and (when available) the
 * HTTP status of the response.
 */
export class B24Error extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(message: string, code: string, status: number, details?: unknown) {
    super(message);
    this.name = 'B24Error';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** Configuration accepted by the B24Client constructor. */
export interface B24ClientConfig {
  /** Bitrix24 portal domain, e.g. "example.bitrix24.ru". */
  portal: string;
  /** OAuth access token forwarded from the iframe SDK. */
  accessToken: string;
  /**
   * Optional fetch implementation override — defaults to global fetch.
   * Tests pass a mock here to avoid hitting the network.
   */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. Defaults to 15000. */
  timeoutMs?: number;
}

/** Shape of the canonical Bitrix24 REST envelope. */
interface B24Envelope<T> {
  result?: T;
  error?: string;
  error_description?: string;
  next?: number;
  total?: number;
  time?: unknown;
}

/** A single call inside a batch request. */
export interface B24BatchCall {
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Bitrix24 batch envelope. The batch endpoint returns one envelope
 * per call, keyed by the original call name.
 */
export interface B24BatchResult<T = unknown> {
  result: Record<string, T>;
  result_error: Record<string, string>;
  result_total?: Record<string, number>;
  result_next?: Record<string, number>;
  result_time?: Record<string, unknown>;
}

/**
 * Disk file metadata returned by `disk.folder.uploadfile`.
 */
export interface B24DiskFile {
  ID: number;
  NAME: string;
  DOWNLOAD_URL: string;
  DETAIL_URL?: string;
  SIZE?: number;
  CREATE_TIME?: string;
}

/**
 * REST wrapper. Construct one per request — instances are cheap and
 * carry only the access token + portal pair.
 */
export class B24Client {
  private readonly portal: string;
  private readonly accessToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: B24ClientConfig) {
    if (!config.portal) throw new Error('B24Client: portal is required');
    if (!config.accessToken) {
      throw new Error('B24Client: accessToken is required');
    }
    this.portal = config.portal.replace(/^https?:\/\//, '').replace(/\/$/, '');
    this.accessToken = config.accessToken;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 15000;
  }

  /** Build the canonical REST URL for a given method. */
  private buildUrl(method: string): string {
    return `https://${this.portal}/rest/${method}.json`;
  }

  /**
   * Call an arbitrary Bitrix24 REST method. Returns the `result`
   * field of the envelope or throws `B24Error` on failure.
   */
  async callMethod<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const url = this.buildUrl(method);
    const body = JSON.stringify({ ...params, auth: this.accessToken });

    // Single retry on transient network failures. Bitrix24 portals on
    // shared infra occasionally drop the TCP connection mid-handshake;
    // a one-shot retry with a short backoff turns those into a 200
    // instead of bubbling a confusing 502 to the admin UI.
    const maxAttempts = 2;
    let res: Response | undefined;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        });
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    if (!res) {
      throw new B24Error(
        `Network error calling ${method}: ${(lastErr as Error)?.message ?? 'unknown'}`,
        'NETWORK_ERROR',
        0,
        lastErr,
      );
    }

    let envelope: B24Envelope<T>;
    try {
      envelope = (await res.json()) as B24Envelope<T>;
    } catch (err) {
      throw new B24Error(
        `Failed to parse JSON from ${method}`,
        'INVALID_JSON',
        res.status,
        err,
      );
    }

    if (envelope.error) {
      throw new B24Error(
        envelope.error_description ?? envelope.error,
        envelope.error,
        res.status,
        envelope,
      );
    }
    if (envelope.result === undefined) {
      throw new B24Error(
        `Empty result from ${method}`,
        'EMPTY_RESULT',
        res.status,
        envelope,
      );
    }
    return envelope.result;
  }

  /**
   * Execute a batch of REST calls in a single request. The `calls`
   * argument is a record `{ name: { method, params } }` — the keys
   * become the keys in the response `result` map. Bitrix24 supports
   * up to 50 calls per batch.
   */
  async callBatch<T = unknown>(
    calls: Record<string, B24BatchCall>,
    halt = false,
  ): Promise<B24BatchResult<T>> {
    const cmd: Record<string, string> = {};
    for (const [name, call] of Object.entries(calls)) {
      const query = new URLSearchParams();
      const params = call.params ?? {};
      for (const [k, v] of Object.entries(params)) {
        appendParam(query, k, v);
      }
      cmd[name] = `${call.method}?${query.toString()}`;
    }
    return this.callMethod<B24BatchResult<T>>('batch', { halt: halt ? 1 : 0, cmd });
  }

  /* ----------------------------------------------------------------- */
  /* CRM helpers                                                        */
  /* ----------------------------------------------------------------- */

  /** `crm.deal.get` — returns the raw deal record. */
  async getDeal(id: number): Promise<Record<string, unknown>> {
    return this.callMethod<Record<string, unknown>>('crm.deal.get', { id });
  }

  /**
   * `crm.deal.fields` — returns the field metadata for deals,
   * normalised into our `DealField[]` shape for the FieldPicker.
   *
   * NOTE: `crm.deal.fields` returns only the technical FIELD_NAME for
   * UF_CRM_* user-defined fields (no human label). To match what the
   * admin sees in Bitrix24's UI we additionally fetch
   * `crm.deal.userfield.list` with `LANG: 'ru'` and override the
   * `title` of UF_CRM_* entries with EDIT_FORM_LABEL / LIST_COLUMN_LABEL.
   */
  async getDealFields(): Promise<DealField[]> {
    const [raw, ufLabels] = await Promise.all([
      this.callMethod<Record<string, RawDealField>>('crm.deal.fields'),
      this.fetchUserFieldLabels('crm.deal.userfield.list'),
    ]);
    return Object.entries(raw).map(([code, meta]) =>
      normalizeDealField(code, meta, ufLabels.get(code)),
    );
  }

  /** `crm.contact.fields` — contact field metadata (with UF labels). */
  async getContactFields(): Promise<DealField[]> {
    const [raw, ufLabels] = await Promise.all([
      this.callMethod<Record<string, RawDealField>>('crm.contact.fields'),
      this.fetchUserFieldLabels('crm.contact.userfield.list'),
    ]);
    return Object.entries(raw).map(([code, meta]) =>
      normalizeDealField(code, meta, ufLabels.get(code)),
    );
  }

  /** `crm.company.fields` — company field metadata (with UF labels). */
  async getCompanyFields(): Promise<DealField[]> {
    const [raw, ufLabels] = await Promise.all([
      this.callMethod<Record<string, RawDealField>>('crm.company.fields'),
      this.fetchUserFieldLabels('crm.company.userfield.list'),
    ]);
    return Object.entries(raw).map(([code, meta]) =>
      normalizeDealField(code, meta, ufLabels.get(code)),
    );
  }

  /**
   * Fetch user-field labels for an entity via the corresponding
   * `crm.<entity>.userfield.list` method. Returns a Map keyed by
   * FIELD_NAME (`UF_CRM_*`) with the resolved human label.
   *
   * IMPORTANT: per the Bitrix24 docs, the EDIT_FORM_LABEL /
   * LIST_COLUMN_LABEL / LIST_FILTER_LABEL / ERROR_MESSAGE / HELP_MESSAGE
   * fields are ONLY returned when `filter.LANG` is supplied. Without
   * it the response contains the technical FIELD_NAME but no human
   * label. We always pass `LANG: 'ru'` so admins see the labels they
   * set when creating the field. Failures are swallowed — falling back
   * to the technical code is better than refusing to render the
   * picker.
   */
  private async fetchUserFieldLabels(
    method: string,
    lang = 'ru',
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    try {
      const list = await this.callMethod<Array<Record<string, unknown>>>(
        method,
        { filter: { LANG: lang }, order: { SORT: 'ASC' } },
      );
      for (const raw of list) {
        const fieldName = String(raw.FIELD_NAME ?? '');
        if (!fieldName) continue;
        const label =
          pickLocalizedLabel(raw.EDIT_FORM_LABEL) ??
          pickLocalizedLabel(raw.LIST_COLUMN_LABEL) ??
          pickLocalizedLabel(raw.LIST_FILTER_LABEL);
        if (label) out.set(fieldName, label);
      }
    } catch {
      // Ignore — caller will fall back to the technical code.
    }
    return out;
  }

  /**
   * `crm.deal.userfield.list` — list of user-defined deal fields.
   * Used by the settings page to populate the file-field dropdown.
   */
  async listDealUserFields(lang = 'ru'): Promise<Array<Record<string, unknown>>> {
    return this.callMethod<Array<Record<string, unknown>>>(
      'crm.deal.userfield.list',
      { filter: { LANG: lang }, order: { SORT: 'ASC' } },
    );
  }

  /** `crm.deal.userfield.add` — register a new UF_CRM_* field. */
  async addDealUserField(field: Record<string, unknown>): Promise<number> {
    return this.callMethod<number>('crm.deal.userfield.add', { fields: field });
  }

  /** `crm.deal.update` — patch a deal. */
  async updateDeal(id: number, fields: Record<string, unknown>): Promise<boolean> {
    return this.callMethod<boolean>('crm.deal.update', { id, fields });
  }

  /** `crm.contact.get` — full contact record. */
  async getContact(id: number): Promise<Record<string, unknown>> {
    return this.callMethod<Record<string, unknown>>('crm.contact.get', { id });
  }

  /** `crm.company.get` — full company record. */
  async getCompany(id: number): Promise<Record<string, unknown>> {
    return this.callMethod<Record<string, unknown>>('crm.company.get', { id });
  }

  /**
   * `crm.deal.contact.items.get` — list of contacts attached to a
   * deal (each item has CONTACT_ID, IS_PRIMARY, etc).
   */
  async getDealContacts(dealId: number): Promise<Array<Record<string, unknown>>> {
    return this.callMethod<Array<Record<string, unknown>>>(
      'crm.deal.contact.items.get',
      { id: dealId },
    );
  }

  /** `crm.timeline.comment.add` — append a comment to the deal timeline. */
  async addTimelineComment(dealId: number, text: string): Promise<number> {
    return this.callMethod<number>('crm.timeline.comment.add', {
      fields: {
        ENTITY_ID: dealId,
        ENTITY_TYPE: 'deal',
        COMMENT: text,
      },
    });
  }

  /* ----------------------------------------------------------------- */
  /* User & disk helpers                                                */
  /* ----------------------------------------------------------------- */

  /**
   * `user.get` — search portal users by FILTER.NAME / LAST_NAME, etc.
   * Returns a list of raw user records.
   */
  async listUsers(params: Record<string, unknown> = {}): Promise<
    Array<Record<string, unknown>>
  > {
    return this.callMethod<Array<Record<string, unknown>>>('user.get', params);
  }

  /**
   * `disk.folder.uploadfile` — upload a binary file (as base64) to
   * the given Bitrix24 disk folder. Returns the disk file metadata.
   *
   * @param folderId  numeric folder id (use 0 for the user's drive root)
   * @param filename  display name shown in disk
   * @param content   raw bytes (Buffer) — will be base64-encoded
   */
  async uploadDiskFile(
    folderId: number,
    filename: string,
    content: Buffer,
  ): Promise<B24DiskFile> {
    const fileContentBase64 = content.toString('base64');
    return this.callMethod<B24DiskFile>('disk.folder.uploadfile', {
      id: folderId,
      data: { NAME: filename },
      fileContent: [filename, fileContentBase64],
      generateUniqueName: true,
    });
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Raw shape of an entry in `crm.deal.fields`. Built-in fields use
 * plain strings for the label keys, but UF_CRM_* fields come back
 * with localized objects keyed by language ({ ru, en, ... }), so
 * each label slot is typed as `unknown` and resolved by
 * `pickLocalizedLabel`.
 */
interface RawDealField {
  type: string;
  isRequired?: boolean;
  isReadOnly?: boolean;
  isImmutable?: boolean;
  isMultiple?: boolean;
  isDynamic?: boolean;
  title?: unknown;
  formLabel?: unknown;
  listLabel?: unknown;
  filterLabel?: unknown;
  items?: Array<{ ID?: string | number; VALUE: string }>;
}

/**
 * Pull a human label out of a value that may be either a plain string
 * (built-in fields) or a locale-keyed object (UF_CRM_* fields).
 * Mirrors the logic in routes/settings.ts::pickLocalized — duplicated
 * here so this module stays self-contained.
 */
function pickLocalizedLabel(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value || null;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['ru', 'en', 'de', 'default']) {
      const v = obj[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    for (const v of Object.values(obj)) {
      if (typeof v === 'string' && v.length > 0) return v;
    }
  }
  return null;
}

function normalizeDealField(
  code: string,
  meta: RawDealField,
  userFieldLabel?: string,
): DealField {
  // For UF_CRM_* fields the title returned by `crm.<entity>.fields`
  // is just the technical FIELD_NAME. Prefer the label fetched from
  // `crm.<entity>.userfield.list` (LANG=ru) when available, so the
  // FieldPicker shows the same human-readable name the admin sees in
  // the Bitrix24 UI.
  const title =
    userFieldLabel ??
    pickLocalizedLabel(meta.title) ??
    pickLocalizedLabel(meta.formLabel) ??
    pickLocalizedLabel(meta.listLabel) ??
    pickLocalizedLabel(meta.filterLabel) ??
    code;
  return {
    code,
    title,
    type: meta.type,
    isRequired: meta.isRequired,
    isUserField: code.startsWith('UF_'),
    isMultiple: meta.isMultiple,
    items: meta.items?.map((it) => ({
      id: it.ID ?? it.VALUE,
      value: it.VALUE,
    })),
  };
}

/**
 * Recursively flatten a value into URLSearchParams-compatible
 * key/value pairs using Bitrix24's PHP-style array syntax
 * (`fields[NAME]=foo&fields[VALUES][0]=bar`). Used by the batch
 * builder.
 */
function appendParam(
  query: URLSearchParams,
  key: string,
  value: unknown,
): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, idx) => {
      appendParam(query, `${key}[${idx}]`, item);
    });
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      appendParam(query, `${key}[${k}]`, v);
    }
    return;
  }
  query.append(key, String(value));
}
