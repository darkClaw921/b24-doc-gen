/**
 * Pure helpers + constants for the FormulaBuilder "часто используемые
 * поля" palette: the recent-fields history (persisted in localStorage)
 * and the default seed list. Kept free of React imports so the reducer
 * logic can be unit-tested.
 */

/** One entry of the quick-fields palette. */
export interface QuickField {
  label: string;
  token: string;
}

/** How many chips show on one palette page. */
export const QUICK_FIELDS_PAGE_SIZE = 6;
/** Max stored "recent" fields (usage history). */
export const QUICK_FIELDS_MAX = 20;
/** localStorage key for the usage history. */
export const QUICK_FIELDS_STORAGE_KEY = 'b24dg:recent-fields';

/**
 * Default set of common fields — a seed shown until the admin has
 * inserted their own. Real usage promotes fields above these.
 */
export const DEFAULT_QUICK_FIELDS: QuickField[] = [
  { label: 'Сумма сделки', token: 'DEAL.OPPORTUNITY' },
  { label: 'Название сделки', token: 'DEAL.TITLE' },
  { label: 'Имя контакта', token: 'CONTACT.NAME' },
  { label: 'Фамилия контакта', token: 'CONTACT.LAST_NAME' },
  { label: 'Телефон контакта', token: 'CONTACT.PHONE' },
  { label: 'Email контакта', token: 'CONTACT.EMAIL' },
  { label: 'Компания', token: 'COMPANY.TITLE' },
  { label: 'Ответственный (имя)', token: 'ASSIGNED.NAME' },
  { label: 'Ответственный (фамилия)', token: 'ASSIGNED.LAST_NAME' },
  { label: 'Должность ответственного', token: 'ASSIGNED.WORK_POSITION' },
];

/** Read the history from localStorage, tolerating corrupt / absent data. */
export function loadRecentFields(): QuickField[] {
  try {
    const raw = localStorage.getItem(QUICK_FIELDS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (x): x is QuickField =>
          x && typeof x.token === 'string' && typeof x.label === 'string',
      );
    }
  } catch {
    /* ignore — corrupt JSON or unavailable storage */
  }
  return [];
}

/**
 * Merge the history with the default fields so the palette is never
 * empty: recent first, then defaults not already present, capped at
 * `QUICK_FIELDS_MAX`.
 */
export function mergeQuickFields(recent: QuickField[]): QuickField[] {
  const seen = new Set(recent.map((f) => f.token));
  const merged = [...recent];
  for (const d of DEFAULT_QUICK_FIELDS) {
    if (merged.length >= QUICK_FIELDS_MAX) break;
    if (!seen.has(d.token)) {
      merged.push(d);
      seen.add(d.token);
    }
  }
  return merged.slice(0, QUICK_FIELDS_MAX);
}

/**
 * Return a new history with `{ token, label }` moved to the front,
 * de-duplicated by token and capped at `QUICK_FIELDS_MAX`. Pure.
 */
export function addRecentField(
  list: QuickField[],
  token: string,
  label: string,
): QuickField[] {
  return [{ token, label }, ...list.filter((f) => f.token !== token)].slice(
    0,
    QUICK_FIELDS_MAX,
  );
}

/** Persist the history, swallowing storage errors (private mode, quota). */
export function saveRecentFields(list: QuickField[]): void {
  try {
    localStorage.setItem(QUICK_FIELDS_STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* ignore — storage unavailable */
  }
}
