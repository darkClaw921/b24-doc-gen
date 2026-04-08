/**
 * Client-side helpers for building and validating template formulas.
 *
 * This module is deliberately thin — the authoritative validator is
 * the mathjs engine running on the backend (`routes/formulas.ts ::
 * POST /api/formulas/validate`). We only do three things here:
 *
 *  1. `validateLocally(expression)` — a synchronous sanity check that
 *     catches the most common mistakes (empty expression, unbalanced
 *     parentheses/quotes) without a round-trip. The builder UI uses
 *     it to surface immediate feedback while the user is typing, and
 *     debounces the remote validator.
 *
 *  2. `validateRemote(expression)` — a thin wrapper over
 *     `formulasApi.validate` that normalises the backend response into
 *     a `LocalValidationResult` so the UI can treat both paths
 *     uniformly.
 *
 *  3. `generateTagKey(label, existing)` — slugifies a label into a
 *     template-unique `tagKey`, appending `_2`, `_3`, … when needed.
 *     Tag keys are embedded in the TipTap DOM as `data-formula-key`
 *     and join back to the `Formula` row on save.
 *
 * Also exported are `FormulaDependencies` and `LocalValidationResult`
 * types so `FormulaBuilder` can consume them without pulling the
 * backend shared types directly.
 */

import { ApiError, formulasApi, type FormulaDependenciesDTO } from './api';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type FormulaDependencies = FormulaDependenciesDTO;

export interface LocalValidationResult {
  /** True when the validator is happy. */
  valid: boolean;
  /** Human-readable error, present only when `valid === false`. */
  error?: string;
  /** Dependencies found in the expression (only meaningful when valid). */
  dependencies?: FormulaDependencies;
  /** True when the result came from the server round-trip. */
  remote: boolean;
}

/* ------------------------------------------------------------------ */
/* Local (synchronous) validation                                      */
/* ------------------------------------------------------------------ */

/**
 * Fast, synchronous sanity check. Catches:
 *  - empty / whitespace-only expressions,
 *  - unbalanced `(` `)`,
 *  - unclosed `"` / `'` string literals,
 *  - nothing else (mathjs does the heavy lifting server-side).
 *
 * Returns a `LocalValidationResult` with `remote: false`.
 */
export function validateLocally(expression: string): LocalValidationResult {
  const expr = (expression ?? '').trim();
  if (expr.length === 0) {
    return { valid: false, error: 'Формула не может быть пустой', remote: false };
  }
  if (expr.length > 4000) {
    return { valid: false, error: 'Формула слишком длинная (> 4000 символов)', remote: false };
  }

  // Walk the characters once tracking parens + string literals.
  let parens = 0;
  let inDouble = false;
  let inSingle = false;
  let prev = '';

  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i];
    const escaped = prev === '\\';

    if (inDouble) {
      if (ch === '"' && !escaped) inDouble = false;
    } else if (inSingle) {
      if (ch === "'" && !escaped) inSingle = false;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '(') {
      parens += 1;
    } else if (ch === ')') {
      parens -= 1;
      if (parens < 0) {
        return {
          valid: false,
          error: 'Лишняя закрывающая скобка',
          remote: false,
        };
      }
    }
    prev = escaped ? '' : ch;
  }

  if (parens > 0) {
    return { valid: false, error: 'Нехватает закрывающих скобок', remote: false };
  }
  if (inDouble || inSingle) {
    return { valid: false, error: 'Незакрытая строковая константа', remote: false };
  }

  return { valid: true, remote: false };
}

/* ------------------------------------------------------------------ */
/* Remote validation                                                   */
/* ------------------------------------------------------------------ */

/**
 * Call the backend validator. The backend parses the expression with
 * the sandboxed mathjs instance and reports symbol-level errors the
 * local validator cannot catch (unknown functions, invalid types,
 * etc). Always returns a `LocalValidationResult` — errors from the
 * HTTP layer are collapsed into `valid: false`.
 */
export async function validateRemote(expression: string): Promise<LocalValidationResult> {
  try {
    const response = await formulasApi.validate(expression);
    if (response.valid) {
      return {
        valid: true,
        dependencies: response.dependencies,
        remote: true,
      };
    }
    return {
      valid: false,
      error: response.error ?? 'Сервер отклонил формулу',
      dependencies: response.dependencies,
      remote: true,
    };
  } catch (err) {
    const message =
      err instanceof ApiError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Ошибка сети';
    return { valid: false, error: message, remote: true };
  }
}

/* ------------------------------------------------------------------ */
/* Tag key generation                                                  */
/* ------------------------------------------------------------------ */

/**
 * Slugify a label into a stable, template-unique key.
 *
 * The algorithm:
 *  1. Transliterate common Cyrillic characters so Russian labels
 *     become ASCII-friendly identifiers.
 *  2. Lowercase + replace any run of non-[a-z0-9_] with `_`.
 *  3. Trim leading/trailing underscores, collapse repeats.
 *  4. Fall back to `formula` when the result is empty.
 *  5. Append `_2`, `_3`, … until the key is unique within `existing`.
 */
export function generateTagKey(label: string, existing: ReadonlyArray<string> = []): string {
  const base = slugify(label) || 'formula';
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}_${i}`)) i += 1;
  return `${base}_${i}`;
}

const CYR_MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh',
  щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function slugify(input: string): string {
  const lowered = (input ?? '').toLowerCase();
  let out = '';
  for (const ch of lowered) {
    if (CYR_MAP[ch] !== undefined) {
      out += CYR_MAP[ch];
    } else {
      out += ch;
    }
  }
  out = out.replace(/[^a-z0-9]+/g, '_');
  out = out.replace(/^_+|_+$/g, '');
  out = out.replace(/_+/g, '_');
  return out;
}
