/**
 * Pure helpers + constants for the FormulaBuilder "часто используемые
 * формулы" palette: the history of formulas the admin has actually
 * inserted (persisted in localStorage) and a default seed list.
 *
 * Зачем существует:
 *  - Большинство документов используют одни и те же выражения (ФИО,
 *    сумма деньгами, дата сделки, НДС …). Чтобы не набирать их каждый
 *    раз, конструктор формул показывает палитру быстрого доступа: при
 *    нажатии «Вставить» выражение запоминается, а потом одним кликом
 *    подставляется целиком в новую формулу.
 *
 * Файл намеренно свободен от React-импортов, чтобы reducer-логику
 * можно было покрыть unit-тестами под Node (`quickFormulas.test.ts`).
 */

/** One entry of the quick-formulas palette. */
export interface QuickFormula {
  /** Человекочитаемое имя формулы (подпись чипа). */
  label: string;
  /** Само выражение mathjs, которое подставляется в textarea. */
  expression: string;
}

/** How many chips show on one palette page. */
export const QUICK_FORMULAS_PAGE_SIZE = 6;
/** Max stored "recent" formulas (usage history). */
export const QUICK_FORMULAS_MAX = 20;
/** localStorage key for the usage history. */
export const QUICK_FORMULAS_STORAGE_KEY = 'b24dg:recent-formulas';

/**
 * Default set of common formulas — a seed shown until the admin has
 * inserted their own. Real usage promotes formulas above these.
 */
export const DEFAULT_QUICK_FORMULAS: QuickFormula[] = [
  { label: 'ФИО контакта', expression: 'concat(CONTACT.NAME, " ", CONTACT.LAST_NAME)' },
  { label: 'Сумма сделки (деньги)', expression: 'format(DEAL.OPPORTUNITY, "money")' },
  { label: 'Дата сделки', expression: 'dateFormat(DEAL.BEGINDATE, "dd.MM.yyyy")' },
  { label: 'Сумма товаров', expression: 'format(productSum("SUM"), "money")' },
  { label: 'НДС 20%', expression: 'format(DEAL.OPPORTUNITY * 0.2, "money")' },
  {
    label: 'Ответственный',
    expression: 'concat(ASSIGNED.NAME, " ", ASSIGNED.LAST_NAME)',
  },
];

/** Read the history from localStorage, tolerating corrupt / absent data. */
export function loadRecentFormulas(): QuickFormula[] {
  try {
    const raw = localStorage.getItem(QUICK_FORMULAS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (x): x is QuickFormula =>
          x &&
          typeof x.expression === 'string' &&
          typeof x.label === 'string' &&
          x.expression.trim().length > 0,
      );
    }
  } catch {
    /* ignore — corrupt JSON or unavailable storage */
  }
  return [];
}

/**
 * Merge the history with the default formulas so the palette is never
 * empty: recent first, then defaults not already present (deduped by
 * expression), capped at `QUICK_FORMULAS_MAX`.
 */
export function mergeQuickFormulas(recent: QuickFormula[]): QuickFormula[] {
  const seen = new Set(recent.map((f) => f.expression));
  const merged = [...recent];
  for (const d of DEFAULT_QUICK_FORMULAS) {
    if (merged.length >= QUICK_FORMULAS_MAX) break;
    if (!seen.has(d.expression)) {
      merged.push(d);
      seen.add(d.expression);
    }
  }
  return merged.slice(0, QUICK_FORMULAS_MAX);
}

/**
 * Return a new history with `{ expression, label }` moved to the front,
 * de-duplicated by expression and capped at `QUICK_FORMULAS_MAX`. Pure.
 */
export function addRecentFormula(
  list: QuickFormula[],
  expression: string,
  label: string,
): QuickFormula[] {
  return [
    { expression, label },
    ...list.filter((f) => f.expression !== expression),
  ].slice(0, QUICK_FORMULAS_MAX);
}

/** Persist the history, swallowing storage errors (private mode, quota). */
export function saveRecentFormulas(list: QuickFormula[]): void {
  try {
    localStorage.setItem(QUICK_FORMULAS_STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* ignore — storage unavailable */
  }
}
