/**
 * Thin fetch-based API client for the b24-doc-gen backend.
 *
 * Every request automatically forwards the Bitrix24 iframe auth as
 * `X-B24-Access-Token` / `X-B24-Member-Id` / `X-B24-Domain` headers
 * (see `lib/b24.ts::getB24AuthHeaders`). The backend's auth
 * middleware verifies them and rejects with 401 if missing.
 *
 * The API base URL defaults to `/api` so the Vite dev server proxy
 * (`apps/frontend/vite.config.ts`) can route it to the backend.
 */

import { getB24AuthHeaders } from './b24';

/**
 * Generic JSON error envelope returned by the backend. We accept two
 * shapes:
 *
 *   1) The Phase 6 wrapped form `{ error: { code, message, details? } }`
 *      produced by the central error handler in `server.ts`.
 *   2) The legacy flat form `{ error?, message?, statusCode? }`
 *      produced by fastify-sensible helpers (`reply.unauthorized(...)`).
 *
 * `extractApiMessage` normalizes both into a single user-facing string.
 */
export interface ApiErrorBody {
  code?: string;
  message?: string;
  details?: unknown;
}

export interface ApiErrorResponse {
  /** Wrapped form (phase 6). When this is an object, prefer it. */
  error?: string | ApiErrorBody;
  /** Legacy flat form. */
  message?: string;
  statusCode?: number;
}

/** Pull the best human-readable message out of any error payload. */
export function extractApiMessage(payload: ApiErrorResponse | null, fallback: string): string {
  if (!payload) return fallback;
  if (payload.error && typeof payload.error === 'object' && payload.error.message) {
    return payload.error.message;
  }
  if (typeof payload.error === 'string' && payload.error.length > 0) {
    return payload.error;
  }
  if (payload.message) return payload.message;
  return fallback;
}

/** Pull the stable machine code out of any error payload. */
export function extractApiCode(payload: ApiErrorResponse | null): string | undefined {
  if (!payload) return undefined;
  if (payload.error && typeof payload.error === 'object' && payload.error.code) {
    return payload.error.code;
  }
  if (typeof payload.error === 'string' && payload.error.length > 0) {
    return payload.error;
  }
  return undefined;
}

/** Custom error thrown by the api client on non-2xx responses. */
export class ApiError extends Error {
  readonly status: number;
  readonly payload: ApiErrorResponse | null;
  readonly code?: string;

  constructor(message: string, status: number, payload: ApiErrorResponse | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
    this.code = extractApiCode(payload);
  }
}

const BASE_URL = '/api';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: unknown;
  signal?: AbortSignal;
}

/** Low-level request helper. Returns parsed JSON or throws ApiError. */
export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = path.startsWith('/') ? `${BASE_URL}${path}` : `${BASE_URL}/${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...getB24AuthHeaders(),
  };

  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });

  let data: unknown = null;
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const payload = (data as ApiErrorResponse | null) ?? null;
    const message = extractApiMessage(payload, `HTTP ${res.status}`);
    throw new ApiError(message, res.status, payload);
  }

  return data as T;
}

/**
 * Multipart upload helper. Sends `FormData` and reports progress to
 * the optional `onProgress` callback. Built on `XMLHttpRequest` because
 * `fetch` does not expose upload-progress events. The B24 auth
 * headers are forwarded so the backend middleware accepts the request.
 */
export interface UploadOptions {
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}

export function uploadRequest<T>(
  path: string,
  formData: FormData,
  opts: UploadOptions = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const url = path.startsWith('/') ? `${BASE_URL}${path}` : `${BASE_URL}/${path}`;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);

    // Forward Bitrix24 auth headers (Content-Type is set by the browser).
    const authHeaders = getB24AuthHeaders();
    for (const [k, v] of Object.entries(authHeaders)) {
      try {
        xhr.setRequestHeader(k, v);
      } catch {
        /* ignore unsettable headers */
      }
    }

    if (opts.signal) {
      const onAbort = () => {
        xhr.abort();
        reject(new ApiError('Upload aborted', 0, null));
      };
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && opts.onProgress) {
        opts.onProgress(e.loaded, e.total);
      }
    };

    xhr.onload = () => {
      let data: unknown = null;
      const contentType = xhr.getResponseHeader('content-type') ?? '';
      if (contentType.includes('application/json')) {
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          data = null;
        }
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data as T);
      } else {
        const payload = (data as ApiErrorResponse | null) ?? null;
        const message = extractApiMessage(payload, `HTTP ${xhr.status}`);
        reject(new ApiError(message, xhr.status, payload));
      }
    };

    xhr.onerror = () => reject(new ApiError('Network error', 0, null));

    xhr.send(formData);
  });
}

/* ------------------------------------------------------------------ */
/* Typed endpoint helpers                                              */
/* ------------------------------------------------------------------ */

export interface PortalUserDTO {
  id: number;
  name: string;
  lastName: string;
  fullName: string;
  email: string;
  active: boolean;
}

export interface InstallStatusDTO {
  installed: boolean;
  adminUserIds: number[];
  dealFieldBinding: string | null;
  portalDomain: string | null;
  installedAt: string | null;
}

export interface InstallSettingsDTO {
  id: number;
  portalDomain: string;
  adminUserIds: number[];
  dealFieldBinding: string | null;
  installedAt: string;
}

/* ------------------------------------------------------------------ */
/* Current user / role                                                  */
/* ------------------------------------------------------------------ */

export type AppRoleDTO = 'admin' | 'user';

export interface MeDTO {
  userId: number;
  role: AppRoleDTO;
}

export const meApi = {
  /** Resolve the current user id and app role from the backend. */
  get: (signal?: AbortSignal) => apiRequest<MeDTO>('/me', { signal }),
};

export const installApi = {
  status: () => apiRequest<InstallStatusDTO>('/install/status'),

  install: (body: { adminUserIds: number[]; dealFieldBinding?: string | null }) =>
    apiRequest<{ settings: InstallSettingsDTO }>('/install', {
      method: 'POST',
      body,
    }),

  registerPlacements: (body: { handlerUrl?: string } = {}) =>
    apiRequest<{
      results: Record<string, { ok: boolean; error?: string; code?: string }>;
      availablePlacements: string[];
      placementListError?: string;
    }>('/install/register-placements', { method: 'POST', body }),
};

export const usersApi = {
  search: (search: string, signal?: AbortSignal) => {
    const qs = new URLSearchParams();
    if (search) qs.set('search', search);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return apiRequest<{ users: PortalUserDTO[]; count: number }>(`/users${suffix}`, {
      signal,
    });
  },
};

export interface CrmFieldDTO {
  code: string;
  title: string;
  type: string;
  isRequired?: boolean;
  isUserField?: boolean;
  isMultiple?: boolean;
  items?: Array<{ id: string | number; value: string }>;
}

export const dealApi = {
  fields: (id: number) =>
    apiRequest<{ fields: CrmFieldDTO[] }>(`/deal/${id}/fields`),
  data: (id: number) =>
    apiRequest<{
      deal: Record<string, unknown>;
      contact: Record<string, unknown> | null;
      company: Record<string, unknown> | null;
    }>(`/deal/${id}/data`),
};

export const crmApi = {
  /** Load field schemas for all three CRM entities at once. */
  allFields: (signal?: AbortSignal) =>
    apiRequest<{
      deal: CrmFieldDTO[];
      contact: CrmFieldDTO[];
      company: CrmFieldDTO[];
      cached: boolean;
    }>('/crm/fields', { signal }),
};

/* ------------------------------------------------------------------ */
/* Formulas                                                            */
/* ------------------------------------------------------------------ */

export interface FormulaValidateResponse {
  valid: boolean;
  error?: string;
  dependencies: FormulaDependenciesDTO;
}

export interface FormulaEvaluateResponse {
  ok: boolean;
  value: string;
  raw: number | string | boolean | null;
  error?: string;
  dependencies: FormulaDependenciesDTO;
}

export const formulasApi = {
  validate: (expression: string) =>
    apiRequest<FormulaValidateResponse>('/formulas/validate', {
      method: 'POST',
      body: { expression },
    }),
  evaluate: (body: { expression: string; dealId?: number; context?: unknown }) =>
    apiRequest<FormulaEvaluateResponse>('/formulas/evaluate', {
      method: 'POST',
      body,
    }),
};

/* ------------------------------------------------------------------ */
/* Themes                                                              */
/* ------------------------------------------------------------------ */

export interface ThemeDTO {
  id: string;
  name: string;
  order: number;
  /** Whether the generate pipeline posts a timeline comment for this theme. */
  addToTimeline: boolean;
  /** UF_CRM_* file field for this theme; null falls back to AppSettings. */
  dealFieldBinding: string | null;
  templatesCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateThemeBody {
  name?: string;
  order?: number;
  addToTimeline?: boolean;
  dealFieldBinding?: string | null;
}

export const themesApi = {
  list: (signal?: AbortSignal) =>
    apiRequest<{ themes: ThemeDTO[] }>('/themes', { signal }),

  create: (body: {
    name: string;
    order?: number;
    addToTimeline?: boolean;
    dealFieldBinding?: string | null;
  }) => apiRequest<{ theme: ThemeDTO }>('/themes', { method: 'POST', body }),

  update: (id: string, body: UpdateThemeBody) =>
    apiRequest<{ theme: ThemeDTO }>(`/themes/${id}`, { method: 'PUT', body }),

  delete: (id: string) =>
    apiRequest<void>(`/themes/${id}`, { method: 'DELETE' }),
};

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

export interface TemplateListItemDTO {
  id: string;
  name: string;
  themeId: string;
  themeName?: string;
  formulasCount: number;
  hasOriginalDocx: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FormulaDependenciesDTO {
  deal: string[];
  contact: string[];
  company: string[];
}

export interface FormulaDTO {
  id: string;
  templateId: string;
  tagKey: string;
  label: string;
  expression: string;
  dependsOn: FormulaDependenciesDTO;
}

export interface TemplateDTO {
  id: string;
  name: string;
  themeId: string;
  contentHtml: string;
  formulas: FormulaDTO[];
  hasOriginalDocx: boolean;
  originalDocxBase64?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FormulaInputDTO {
  id?: string;
  tagKey: string;
  label: string;
  expression: string;
  dependsOn: FormulaDependenciesDTO;
}

export interface UpdateTemplateBody {
  name?: string;
  themeId?: string;
  contentHtml?: string;
  formulas?: FormulaInputDTO[];
}

/* ------------------------------------------------------------------ */
/* Preview / generation                                                */
/* ------------------------------------------------------------------ */

export interface FormulaEvaluationResultDTO {
  tagKey: string;
  label: string;
  expression: string;
  value: string;
  rawValue?: number | string | boolean | null;
  error?: string;
}

export interface TemplatePreviewResponseDTO {
  /** HTML where formula spans carry data-computed-value. */
  html: string;
  /** Per-formula evaluation results, indexed by tagKey. */
  formulas: Record<string, FormulaEvaluationResultDTO>;
}

export interface GenerateBindingDTO {
  fieldName: string;
  ok: boolean;
  error?: string;
}

export interface GenerateResponseDTO {
  fileId: number;
  fileName: string;
  downloadUrl: string;
  timelineCommentId?: number;
  formulas: Record<string, FormulaEvaluationResultDTO>;
  binding: GenerateBindingDTO | null;
  timeline: { ok: boolean; commentId?: number; error?: string };
  warnings: string[];
}

export const templatesApi = {
  list: (params: { themeId?: string; search?: string } = {}, signal?: AbortSignal) => {
    const qs = new URLSearchParams();
    if (params.themeId) qs.set('themeId', params.themeId);
    if (params.search) qs.set('search', params.search);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return apiRequest<{ templates: TemplateListItemDTO[] }>(`/templates${suffix}`, {
      signal,
    });
  },

  get: (id: string, opts: { withDocx?: boolean } = {}) => {
    const qs = new URLSearchParams();
    if (opts.withDocx) qs.set('withDocx', '1');
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return apiRequest<{ template: TemplateDTO }>(`/templates/${id}${suffix}`);
  },

  preview: (id: string, dealId: number, signal?: AbortSignal) =>
    apiRequest<TemplatePreviewResponseDTO>(
      `/templates/${id}/preview?dealId=${encodeURIComponent(String(dealId))}`,
      { signal },
    ),

  create: (body: { name: string; themeId: string; contentHtml?: string }) =>
    apiRequest<{ template: TemplateDTO }>('/templates', { method: 'POST', body }),

  update: (id: string, body: UpdateTemplateBody) =>
    apiRequest<{ template: TemplateDTO }>(`/templates/${id}`, { method: 'PUT', body }),

  delete: (id: string) =>
    apiRequest<void>(`/templates/${id}`, { method: 'DELETE' }),

  upload: (
    body: { name: string; themeId: string; file: File },
    opts: UploadOptions = {},
  ) => {
    const formData = new FormData();
    formData.append('name', body.name);
    formData.append('themeId', body.themeId);
    formData.append('file', body.file);
    return uploadRequest<{ template: TemplateDTO; warnings: string[] }>(
      '/templates/upload',
      formData,
      opts,
    );
  },
};

export const generateApi = {
  generate: (body: { templateId: string; dealId: number }) =>
    apiRequest<GenerateResponseDTO>('/generate', { method: 'POST', body }),
};

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export interface SettingsDTO {
  id: number;
  portalDomain: string;
  adminUserIds: number[];
  dealFieldBinding: string | null;
  installedAt: string;
}

export interface DealFileFieldDTO {
  id: number;
  fieldName: string;
  xmlId: string | null;
  editFormLabel: string | null;
  listLabel: string | null;
  multiple: boolean;
}

export const settingsApi = {
  get: (signal?: AbortSignal) =>
    apiRequest<{ settings: SettingsDTO }>('/settings', { signal }),

  update: (body: { dealFieldBinding?: string | null; adminUserIds?: number[] }) =>
    apiRequest<{ settings: SettingsDTO }>('/settings', { method: 'PUT', body }),

  dealFields: (signal?: AbortSignal) =>
    apiRequest<{ fields: DealFileFieldDTO[] }>('/settings/deal-fields', { signal }),

  createField: (body: { xmlId: string; label: string; multiple?: boolean }) =>
    apiRequest<{ field: { id: number; fieldName: string; xmlId: string; label: string } }>(
      '/settings/create-field',
      { method: 'POST', body },
    ),
};
