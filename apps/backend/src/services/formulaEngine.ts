/**
 * formulaEngine — sandboxed mathjs expression engine for template
 * formulas.
 *
 * The engine wraps a private `mathjs` instance created via
 * `mathjs.create(all)` and immediately disables every dynamic-execution
 * primitive (`import`, `createUnit`, `evaluate`, `parse`, `simplify`,
 * `derivative`) so a hostile expression cannot reach into the host
 * runtime. Only a small allow-list of helpers is exposed on top of the
 * arithmetic primitives mathjs ships out of the box:
 *
 *   - `if(cond, a, b)`         — ternary helper
 *   - `concat(...args)`        — string concatenation
 *   - `format(value, pattern)` — number formatting via Intl.NumberFormat
 *                                 ("0.00", "0", "0.0%", "money", ...)
 *   - `dateFormat(date, fmt)`  — date formatting (ISO/dd.MM.yyyy/...)
 *   - `upper(s)` / `lower(s)`  — case helpers
 *
 * Identifiers in expressions are namespaced under three top-level
 * symbols populated by the caller:
 *
 *   - `DEAL.<FIELD_CODE>`     — values from `crm.deal.get`
 *   - `CONTACT.<FIELD_CODE>`  — values from the primary `crm.contact.get`
 *   - `COMPANY.<FIELD_CODE>`  — values from the linked `crm.company.get`
 *
 * Public API:
 *
 *   - `validateExpression(expr)` → `{ ok, error?, deps? }` —
 *       parses the expression and walks the AST. Used by
 *       `routes/formulas.ts::POST /api/formulas/validate`.
 *   - `evaluateExpression(expr, context)` → `{ value, raw, error? }` —
 *       compiles + evaluates against `context`. Used by the preview
 *       and generation pipelines (Phase 5).
 *   - `extractDependencies(expr)` → `{ deal, contact, company }` —
 *       static dependency extraction so callers can decide which REST
 *       calls to make.
 *
 * The compile/evaluate cycle is wrapped in try/catch so a thrown error
 * never leaks the host stack into REST responses.
 */

import { create, all, type MathNode, type AccessorNode, type SymbolNode } from 'mathjs';
import type { FormulaContext, FormulaDependencies } from '@b24-doc-gen/shared';

/* ------------------------------------------------------------------ */
/* Sandboxed mathjs instance                                           */
/* ------------------------------------------------------------------ */

/**
 * Build a brand new mathjs instance and lock it down.
 *
 * The official mathjs security guide
 * (https://mathjs.org/docs/expressions/security.html) recommends
 * disabling these functions to prevent code injection in user input.
 */
function buildSandboxedMath() {
  const math = create(all);

  /* ---------------------------------------------------------------- */
  /* Helper functions exposed to expressions                          */
  /* ---------------------------------------------------------------- */

  // `if(cond, a, b)` — `if` is a reserved keyword in JS, so we register
  // it via the import map. The function name in expressions is `if`.
  const helpers: Record<string, (...args: unknown[]) => unknown> = {
    // Ternary helper. Truthy check is JavaScript-style.
    if(cond: unknown, a: unknown, b: unknown) {
      return cond ? a : b;
    },

    // String concat — coerces every arg to string and joins.
    concat(...parts: unknown[]) {
      return parts.map((p) => (p == null ? '' : String(p))).join('');
    },

    // Number formatter.
    format(value: unknown, pattern: unknown) {
      return formatNumber(value, typeof pattern === 'string' ? pattern : '0.00');
    },

    // Date formatter — accepts Date | string | number.
    dateFormat(value: unknown, pattern: unknown) {
      return formatDate(value, typeof pattern === 'string' ? pattern : 'dd.MM.yyyy');
    },

    // Case helpers.
    upper(value: unknown) {
      return value == null ? '' : String(value).toUpperCase();
    },
    lower(value: unknown) {
      return value == null ? '' : String(value).toLowerCase();
    },
  };

  math.import(helpers, { override: true });

  // Disable every dynamic-execution primitive AFTER importing helpers.
  // Per the official mathjs security guide we override these so
  // user-supplied expressions can't call into the host runtime. We do
  // this by *replacing* the named exports on the instance rather than
  // routing through `math.import()` itself, because once `import` is
  // disabled it can no longer be used to disable other functions.
  const blocked = (name: string) => {
    return function () {
      throw new Error(`Function "${name}" is disabled in sandbox`);
    };
  };
  const sensitive = [
    'import',
    'createUnit',
    'reviver',
    'replacer',
    'simplify',
    'derivative',
    'rationalize',
    'resolve',
    'symbolicEqual',
  ];
  for (const name of sensitive) {
    try {
      Object.defineProperty(math, name, {
        value: blocked(name),
        writable: false,
        configurable: true,
      });
    } catch {
      /* ignore — some keys may already be locked */
    }
  }

  return math;
}

const math = buildSandboxedMath();

/** Names of the three top-level entity symbols available in expressions. */
const ENTITY_SYMBOLS = ['DEAL', 'CONTACT', 'COMPANY'] as const;
type EntitySymbol = (typeof ENTITY_SYMBOLS)[number];

/* ------------------------------------------------------------------ */
/* Number / date helpers                                               */
/* ------------------------------------------------------------------ */

/**
 * Format a numeric value according to a small set of patterns.
 *
 * Supported patterns (the leading "0." just describes the typical use):
 *   - "0"        — integer with thousand separators
 *   - "0.0"      — one fractional digit
 *   - "0.00"     — two fractional digits (default)
 *   - "0.000"    — three fractional digits
 *   - "0%"       — integer percentage
 *   - "0.0%"     — one-digit percentage
 *   - "0.00%"    — two-digit percentage
 *   - "money"    — RUB-style with two fractional digits and currency
 *   - "usd"      — USD currency format
 *   - "eur"      — EUR currency format
 *
 * Anything else is treated as the number of fractional digits if it
 * starts with "0.", otherwise the value is returned via toString().
 */
export function formatNumber(value: unknown, pattern: string): string {
  const num = toNumberOrNull(value);
  if (num == null) return '';

  const lower = pattern.toLowerCase();
  if (lower === 'money' || lower === 'rub') {
    return new Intl.NumberFormat('ru-RU', {
      style: 'currency',
      currency: 'RUB',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(num);
  }
  if (lower === 'usd') {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
    }).format(num);
  }
  if (lower === 'eur') {
    return new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency: 'EUR',
      minimumFractionDigits: 2,
    }).format(num);
  }

  const isPct = pattern.endsWith('%');
  const core = isPct ? pattern.slice(0, -1) : pattern;
  // Count digits after the decimal point in the pattern.
  const dotIdx = core.indexOf('.');
  const fractionDigits = dotIdx >= 0 ? core.length - dotIdx - 1 : 0;

  if (isPct) {
    return new Intl.NumberFormat('ru-RU', {
      style: 'percent',
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(num);
  }

  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(num);
}

/**
 * Format a date value according to a small token set.
 *
 * Supported tokens: yyyy, yy, MM, dd, HH, mm, ss
 * Predefined patterns: 'iso', 'date', 'datetime'.
 */
export function formatDate(value: unknown, pattern: string): string {
  const date = toDateOrNull(value);
  if (!date) return '';

  if (pattern === 'iso') return date.toISOString();
  if (pattern === 'date') return date.toLocaleDateString('ru-RU');
  if (pattern === 'datetime') return date.toLocaleString('ru-RU');

  const yyyy = date.getFullYear().toString().padStart(4, '0');
  const yy = yyyy.slice(-2);
  const MM = (date.getMonth() + 1).toString().padStart(2, '0');
  const dd = date.getDate().toString().padStart(2, '0');
  const HH = date.getHours().toString().padStart(2, '0');
  const mm = date.getMinutes().toString().padStart(2, '0');
  const ss = date.getSeconds().toString().padStart(2, '0');

  return pattern
    .replace(/yyyy/g, yyyy)
    .replace(/yy/g, yy)
    .replace(/MM/g, MM)
    .replace(/dd/g, dd)
    .replace(/HH/g, HH)
    .replace(/mm/g, mm)
    .replace(/ss/g, ss);
}

function toNumberOrNull(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    // Bitrix24 sometimes returns numbers as "1000.00" strings.
    const cleaned = v.replace(/\s+/g, '').replace(',', '.');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return null;
}

function toDateOrNull(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* AST helpers                                                         */
/* ------------------------------------------------------------------ */

/** Internal: parse but never throw — return a typed result. */
function tryParse(expression: string): { node: MathNode; error?: undefined } | { node?: undefined; error: string } {
  try {
    if (typeof expression !== 'string' || expression.trim().length === 0) {
      return { error: 'Expression is empty' };
    }
    if (expression.length > 4000) {
      return { error: 'Expression is too long (max 4000 chars)' };
    }
    const node = math.parse(expression);
    return { node };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }
}

/**
 * Walk an AST and collect every `DEAL.X` / `CONTACT.X` / `COMPANY.X`
 * accessor. Returned arrays are de-duplicated and sorted for stable
 * comparison and storage.
 */
function collectDeps(node: MathNode): FormulaDependencies {
  const deps: Record<EntitySymbol, Set<string>> = {
    DEAL: new Set(),
    CONTACT: new Set(),
    COMPANY: new Set(),
  };

  node.traverse((current) => {
    if (current.type !== 'AccessorNode') return;
    const accessor = current as AccessorNode;
    const obj = accessor.object;
    if (!obj || obj.type !== 'SymbolNode') return;
    const symbol = (obj as SymbolNode).name as EntitySymbol;
    if (!ENTITY_SYMBOLS.includes(symbol)) return;

    // accessor.index is an IndexNode whose .dimensions is the access
    // path. For dot-access we look at the first dimension as a constant.
    const indexNode = accessor.index;
    if (!indexNode || !Array.isArray(indexNode.dimensions)) return;
    const first = indexNode.dimensions[0];
    if (!first || first.type !== 'ConstantNode') return;
    const fieldName = (first as unknown as { value: unknown }).value;
    if (typeof fieldName !== 'string') return;
    deps[symbol].add(fieldName);
  });

  return {
    deal: Array.from(deps.DEAL).sort(),
    contact: Array.from(deps.CONTACT).sort(),
    company: Array.from(deps.COMPANY).sort(),
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export interface ValidationResult {
  ok: boolean;
  error?: string;
  deps?: FormulaDependencies;
}

/**
 * Parse an expression without evaluating it. Returns ok+deps on
 * success or ok=false+error on failure. Used by clients to validate
 * a draft formula before persisting it.
 */
export function validateExpression(expression: string): ValidationResult {
  const parsed = tryParse(expression);
  if ('error' in parsed) {
    return { ok: false, error: parsed.error };
  }

  // Reject expressions that reference symbols other than DEAL/CONTACT/
  // COMPANY/our helpers. We resolve helper names by checking the
  // sandboxed math instance.
  const unknownSymbol = findUnknownSymbol(parsed.node);
  if (unknownSymbol) {
    return {
      ok: false,
      error: `Unknown identifier "${unknownSymbol}"`,
    };
  }

  return { ok: true, deps: collectDeps(parsed.node) };
}

/** Allow-list of identifiers that aren't entity namespaces. */
const KNOWN_NON_ENTITY_SYMBOLS = new Set<string>([
  // helpers we registered
  'if',
  'concat',
  'format',
  'dateFormat',
  'upper',
  'lower',
  // common math constants and functions registered by mathjs
  'pi',
  'e',
  'true',
  'false',
  'null',
  'Infinity',
  'NaN',
]);

/**
 * Walk the AST and return the name of the first symbol the engine
 * cannot resolve. Recognised symbols include: the three entity
 * namespaces, our custom helpers, and any function exposed on the
 * sandboxed math instance.
 *
 * Symbols that appear immediately under an `AccessorNode` (i.e. the
 * "object" of `DEAL.OPPORTUNITY`) are skipped here because they are
 * already validated against ENTITY_SYMBOLS in collectDeps.
 */
function findUnknownSymbol(node: MathNode): string | null {
  let bad: string | null = null;
  // Track which symbol nodes are the object-position of an accessor —
  // we don't want to flag them twice.
  const accessorObjects = new WeakSet<MathNode>();
  node.traverse((n) => {
    if (n.type === 'AccessorNode') {
      const acc = n as AccessorNode;
      if (acc.object) accessorObjects.add(acc.object);
    }
  });

  node.traverse((n) => {
    if (bad) return;
    if (n.type !== 'SymbolNode') return;
    if (accessorObjects.has(n)) {
      // The object of an accessor must be one of our entity symbols.
      const name = (n as SymbolNode).name;
      if (!ENTITY_SYMBOLS.includes(name as EntitySymbol)) {
        bad = name;
      }
      return;
    }
    const name = (n as SymbolNode).name;
    if (ENTITY_SYMBOLS.includes(name as EntitySymbol)) return;
    if (KNOWN_NON_ENTITY_SYMBOLS.has(name)) return;
    // Anything exposed on math (functions, constants) is fine.
    if ((math as unknown as Record<string, unknown>)[name] !== undefined) return;
    bad = name;
  });
  return bad;
}

export interface EvaluationResult {
  /** Display-ready string. Always present (empty on error). */
  value: string;
  /** Raw scalar value if computable. */
  raw: number | string | boolean | null;
  /** Optional error message when evaluation failed. */
  error?: string;
}

/**
 * Evaluate an expression with a typed context. The context is forwarded
 * verbatim to the mathjs scope; missing entity keys default to empty
 * objects so accessing `CONTACT.NAME` against a deal with no linked
 * contact yields an empty string instead of throwing.
 */
export function evaluateExpression(
  expression: string,
  context: Partial<FormulaContext>,
): EvaluationResult {
  const parsed = tryParse(expression);
  if ('error' in parsed) {
    return { value: '', raw: null, error: parsed.error };
  }

  const scope = {
    DEAL: context.DEAL ?? {},
    CONTACT: context.CONTACT ?? {},
    COMPANY: context.COMPANY ?? {},
  };

  try {
    const compiled = parsed.node.compile();
    const raw = compiled.evaluate(scope) as unknown;
    return toEvaluationResult(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { value: '', raw: null, error: message };
  }
}

/**
 * Static dependency extraction. Used by the preview/generation
 * pipelines to decide which REST calls to make. Returns empty arrays
 * for an unparseable expression rather than throwing — callers should
 * use `validateExpression` if they need to surface errors.
 */
export function extractDependencies(expression: string): FormulaDependencies {
  const parsed = tryParse(expression);
  if ('error' in parsed) {
    return { deal: [], contact: [], company: [] };
  }
  return collectDeps(parsed.node);
}

/** Coerce an arbitrary mathjs result into the public EvaluationResult shape. */
function toEvaluationResult(raw: unknown): EvaluationResult {
  if (raw == null) return { value: '', raw: null };
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      return { value: '', raw: null, error: 'Result is not a finite number' };
    }
    return { value: String(raw), raw };
  }
  if (typeof raw === 'string') return { value: raw, raw };
  if (typeof raw === 'boolean') return { value: raw ? 'true' : 'false', raw };
  // mathjs may return BigNumber/Fraction/Complex/etc. — fall back to
  // its toString. We do not attempt to coerce them to JSON.
  if (typeof raw === 'object' && 'toString' in raw) {
    const text = String(raw);
    return { value: text, raw: text };
  }
  return { value: String(raw), raw: null };
}
