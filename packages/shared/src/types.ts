/**
 * Shared TypeScript types for the b24-doc-gen monorepo.
 *
 * These types are used by both frontend (apps/frontend) and backend
 * (apps/backend) to guarantee a consistent contract for the REST API
 * and client/server state handling. Keep this file free of any runtime
 * imports — it must remain a pure type-only module.
 */

/* ------------------------------------------------------------------ */
/* App settings                                                        */
/* ------------------------------------------------------------------ */

/**
 * Application-wide settings stored in the local SQLite DB.
 * There is always a single row (id = 1).
 */
export interface AppSettings {
  /** Fixed primary key, always 1. */
  id: number;
  /** Bitrix24 portal domain, e.g. "example.bitrix24.ru". */
  portalDomain: string;
  /** Bitrix24 user IDs with admin rights inside the app. */
  adminUserIds: number[];
  /**
   * UF_CRM_* user field code of the deal entity where the generated
   * .docx file is attached. Null if not yet configured.
   */
  dealFieldBinding: string | null;
  /** ISO timestamp of the first installation. */
  installedAt: string;
}

/* ------------------------------------------------------------------ */
/* Themes and templates                                                */
/* ------------------------------------------------------------------ */

/**
 * A group (theme) of templates. Used to organize templates on the UI
 * and let admins categorize them. Order is a sort key (asc).
 */
export interface Theme {
  id: string;
  name: string;
  order: number;
  /**
   * If true, the generate pipeline posts a timeline comment with the
   * generated document attached for templates inside this theme.
   */
  addToTimeline: boolean;
  /**
   * Per-theme override for the UF_CRM_* file field where the generated
   * .docx is attached on the deal. When null, the global
   * AppSettings.dealFieldBinding is used (or no binding at all).
   */
  dealFieldBinding: string | null;
  /** Optional list of templates (populated by the backend). */
  templates?: Template[];
  createdAt?: string;
  updatedAt?: string;
}

/**
 * A document template uploaded by an admin. The original .docx file
 * is kept as bytes on the backend for re-editing; the HTML form
 * (with <formula-tag> inline nodes) is what is rendered in TipTap.
 */
export interface Template {
  id: string;
  name: string;
  themeId: string;
  /** HTML produced by mammoth + TipTap, including <formula-tag> nodes. */
  contentHtml: string;
  /**
   * Base64-encoded original .docx. Returned on request only.
   * Undefined when not loaded to reduce payload.
   */
  originalDocxBase64?: string;
  /** Formulas attached to this template. */
  formulas: Formula[];
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Formulas                                                            */
/* ------------------------------------------------------------------ */

/**
 * A formula attached to a template. It is referenced from inside
 * the template HTML by its `tagKey`.
 *
 * Expression language: mathjs-compatible with a small number of
 * helpers registered on the server side (if/concat/format/upper/lower/
 * dateFormat). Identifiers such as DEAL.OPPORTUNITY, CONTACT.NAME,
 * COMPANY.TITLE, COMPANY.UF_CRM_INN refer to values injected by
 * the backend from Bitrix24 REST responses.
 */
export interface Formula {
  id: string;
  /** Template the formula belongs to. */
  templateId: string;
  /** Unique key inside a template, referenced from HTML. */
  tagKey: string;
  /** Human-readable label shown in the builder UI. */
  label: string;
  /** mathjs expression, e.g. "OPPORTUNITY * 0.2". */
  expression: string;
  /** Fields the formula depends on, grouped by entity. */
  dependsOn: FormulaDependencies;
}

/**
 * Fields a formula reads from. Used to decide which REST calls
 * to make when computing a preview.
 */
export interface FormulaDependencies {
  deal: string[];
  contact: string[];
  company: string[];
}

/* ------------------------------------------------------------------ */
/* Bitrix24 deal field metadata                                        */
/* ------------------------------------------------------------------ */

/**
 * Simplified field descriptor matching the shape returned by
 * `crm.deal.fields`. Used by FieldPicker to let the admin pick
 * a field while building a formula.
 */
export interface DealField {
  /** Internal field code, e.g. "OPPORTUNITY", "UF_CRM_12345". */
  code: string;
  /** Localized label. */
  title: string;
  /**
   * Bitrix24 field type, e.g. "string", "double", "datetime",
   * "user", "crm_contact", "enumeration", "file".
   */
  type: string;
  /** True if the field is required on the deal form. */
  isRequired?: boolean;
  /** True if the field is user-defined (UF_CRM_*). */
  isUserField?: boolean;
  /** True if the field holds multiple values. */
  isMultiple?: boolean;
  /**
   * Allowed items for enumeration fields. Undefined for other types.
   */
  items?: Array<{ id: string | number; value: string }>;
}

/* ------------------------------------------------------------------ */
/* Formula runtime context                                             */
/* ------------------------------------------------------------------ */

/**
 * Raw entity values injected by the server before formula evaluation.
 * Keys are the Bitrix24 field codes, values are whatever the REST
 * API returned (numbers, strings, arrays, etc.).
 */
export type EntityValues = Record<string, unknown>;

/**
 * The runtime context passed to a formula evaluator.
 * All three entities may be partially populated depending on what
 * the deal linked to at the moment of generation.
 */
export interface FormulaContext {
  DEAL: EntityValues;
  CONTACT: EntityValues;
  COMPANY: EntityValues;
}

/**
 * Result of evaluating a single formula. Sent back to the frontend
 * so the preview can display both the value and the original
 * expression in a tooltip.
 */
export interface FormulaEvaluationResult {
  tagKey: string;
  label: string;
  expression: string;
  /** Computed value, serialized to a display string. */
  value: string;
  /** Raw value before serialization (if scalar). */
  rawValue?: number | string | boolean | null;
  /** If the expression failed, contains the error message. */
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

/**
 * Payload extracted from a verified Bitrix24 auth token.
 * The backend auth middleware populates this object on the request.
 */
export interface B24AuthPayload {
  /** Bitrix24 user ID. */
  userId: number;
  /** Bitrix24 portal domain, e.g. "example.bitrix24.ru". */
  domain: string;
  /** Whether this user is an admin inside the app. */
  isAppAdmin: boolean;
  /** Raw access token (if still valid). */
  accessToken?: string;
  /** Raw refresh token. */
  refreshToken?: string;
  /** Unix seconds when the access token expires. */
  expiresAt?: number;
}

/* ------------------------------------------------------------------ */
/* API request / response shapes                                       */
/* ------------------------------------------------------------------ */

/** POST /api/install — request body. */
export interface InstallRequest {
  adminUserIds: number[];
  portalDomain: string;
}

/** POST /api/install — response. */
export interface InstallResponse {
  settings: AppSettings;
}

/** GET /api/templates/:id/preview?dealId=... response. */
export interface TemplatePreviewResponse {
  /** HTML with formula tags replaced by evaluated values. */
  html: string;
  /** Per-formula evaluation results, indexed by tagKey. */
  formulas: Record<string, FormulaEvaluationResult>;
}

/** POST /api/generate — request body. */
export interface GenerateRequest {
  templateId: string;
  dealId: number;
}

/** POST /api/generate — response body. */
export interface GenerateResponse {
  fileId: number;
  downloadUrl: string;
  timelineCommentId?: number;
}

/**
 * Generic error envelope returned by the backend.
 *
 * Phase 6 introduced the centralized error handler which always wraps
 * errors in `{ error: { code, message, details? } }`. The legacy flat
 * shape (`{ error, message }`) is still produced by some plugins, so
 * the frontend client tolerates both — see `apps/frontend/src/lib/api.ts`.
 */
export interface ApiErrorBody {
  /** Stable machine code, e.g. "FST_ERR_VALIDATION", "HTTP_403". */
  code: string;
  /** Human-readable message intended for end-user display. */
  message: string;
  /** Optional structured payload (validation errors, stack in dev, etc.). */
  details?: unknown;
}

/** Top-level envelope wrapping an `ApiErrorBody`. */
export interface ApiErrorEnvelope {
  error: ApiErrorBody;
}

/**
 * Legacy / fastify-sensible flat shape. Kept for compatibility with
 * older clients and the plugins that bypass the central error handler.
 */
export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
  statusCode?: number;
}

/* ------------------------------------------------------------------ */
/* Webhook triggers                                                    */
/* ------------------------------------------------------------------ */

/**
 * A webhook trigger that admins can attach to a Theme or a single
 * Template. When Bitrix24 "Outgoing webhook" robot POSTs to the
 * backend URL, the same generation pipeline used by the manual UI
 * button runs for every Template in scope.
 *
 * Dates are serialized as ISO strings (not `Date`) so the shape is
 * safe to transport over JSON between the backend and the frontend.
 */
export interface WebhookSummary {
  /** Primary key (cuid). */
  id: string;
  /** URL-safe cryptorandom token used as the URL segment. */
  token: string;
  /**
   * Full public URL of the webhook, built as
   * `${PUBLIC_URL}/api/webhook/run/${token}` on the backend.
   * The admin copies this URL into the Bitrix24 robot config.
   */
  url: string;
  /**
   * Scope of the webhook:
   * - `theme` — generates every Template inside `themeId`.
   * - `template` — generates the single Template `templateId`.
   */
  scope: 'theme' | 'template';
  /** Target Theme id when `scope === 'theme'`, otherwise null. */
  themeId: string | null;
  /** Target Template id when `scope === 'template'`, otherwise null. */
  templateId: string | null;
  /** Human-readable label shown in the admin UI. */
  label: string | null;
  /** If false, incoming requests are rejected with 403. */
  enabled: boolean;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of the last successful invocation, or null. */
  lastUsedAt: string | null;
  /** Total number of times this webhook has been invoked. */
  useCount: number;
}

/* ------------------------------------------------------------------ */
/* User roles                                                          */
/* ------------------------------------------------------------------ */

/**
 * Role of the current user inside the app. Derived from
 * AppSettings.adminUserIds.
 */
export type AppRole = 'admin' | 'user';
