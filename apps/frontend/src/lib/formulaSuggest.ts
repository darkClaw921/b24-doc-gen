/**
 * formulaSuggest — «обучение по примеру» для вставки формул в редакторе
 * шаблона (`TemplateEditorPage`).
 *
 * Идея:
 *  - Когда администратор выделяет фрагмент в строке документа и вставляет
 *    вместо него формулу, мы запоминаем НЕ выделенный фрагмент, а ШАБЛОН
 *    ВСЕЙ СТРОКИ (абзаца), в которой произошла вставка: место выделения
 *    заменяется маркером, числа маскируются, текст нормализуется.
 *  - Когда позже администратор выделяет текст в ПОХОЖЕЙ строке, мы строим
 *    такой же шаблон и ищем совпадение среди запомненных. Если нашли —
 *    редактор предлагает вставить ту же формулу одним кликом.
 *
 * История хранится в localStorage (на администратора/браузер). Файл
 * свободен от React/DOM-импортов, чтобы reducer-логику можно было
 * покрыть unit-тестами под Node (`formulaSuggest.test.ts`).
 */

import type { FormulaDependencies } from './formulas';

/** Одна запомненная пара «шаблон строки → формула». */
export interface FormulaMemoryEntry {
  /** Нормализованный шаблон строки (с маркером места вставки). */
  pattern: string;
  /** Человекочитаемое имя формулы. */
  label: string;
  /** Выражение mathjs. */
  expression: string;
  /** Зависимости формулы (для немедленной привязки без ревалидации). */
  dependsOn: FormulaDependencies;
}

/** Маркер места выделения/вставки внутри строки-шаблона. */
export const SELECTION_MARK = '⟦⟧'; // ⟦⟧
/** localStorage key для истории сопоставлений. */
export const FORMULA_MEMORY_KEY = 'b24dg:formula-suggestions';
/** Сколько пар максимум храним. */
export const FORMULA_MEMORY_MAX = 200;
/**
 * Порог нечёткого совпадения (коэффициент Сёренсена–Дайса) при отсутствии
 * точного совпадения шаблона. Высокий, чтобы предлагать только в реально
 * похожих строках.
 */
export const SUGGEST_THRESHOLD = 0.8;

/**
 * Нормализовать текст строки: нижний регистр, схлопнуть пробелы, обрезать
 * края и заменить любые числа (с разделителями) на «#», чтобы строки,
 * отличающиеся лишь значениями, считались одинаковыми.
 */
export function normalizeLine(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\d][\d\s.,]*\d|\d/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Построить шаблон строки: вставить `SELECTION_MARK` на место выделения
 * `[startOffset, endOffset)` внутри `lineText`, затем нормализовать.
 * Возвращает null, если строка пустая (нечего сопоставлять).
 *
 * Смещения — позиции внутри текста строки (parentOffset в ProseMirror).
 * Для схлопнутого выделения (startOffset === endOffset) маркер ставится в
 * точку курсора.
 */
export function buildLinePattern(
  lineText: string,
  startOffset: number,
  endOffset: number,
): string | null {
  if (!lineText || !lineText.trim()) return null;
  const s = Math.max(0, Math.min(startOffset, lineText.length));
  const e = Math.max(s, Math.min(endOffset, lineText.length));
  const withMark = lineText.slice(0, s) + SELECTION_MARK + lineText.slice(e);
  // Нормализуем, сохранив маркер (его символы не затрагиваются заменами).
  const normalized = normalizeLine(withMark);
  return normalized.includes(SELECTION_MARK) ? normalized : null;
}

/**
 * Коэффициент Сёренсена–Дайса по биграммам символов: 0 (нет общего) … 1
 * (идентичны). Устойчив к мелким различиям и перестановкам.
 */
export function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      m.set(bg, (m.get(bg) ?? 0) + 1);
    }
    return m;
  };
  const ma = bigrams(a);
  const mb = bigrams(b);
  let overlap = 0;
  let total = 0;
  for (const n of ma.values()) total += n;
  for (const [bg, nb] of mb) {
    total += nb;
    const na = ma.get(bg);
    if (na) overlap += Math.min(na, nb);
  }
  return total === 0 ? 0 : (2 * overlap) / total;
}

/**
 * Найти подходящую запомненную формулу для шаблона строки `pattern`.
 * Сначала ищется точное совпадение шаблона; если нет — лучший нечёткий
 * матч с коэффициентом ≥ `SUGGEST_THRESHOLD`. Возвращает null, если ничего
 * подходящего нет.
 */
export function findFormulaSuggestion(
  pattern: string | null,
  list: ReadonlyArray<FormulaMemoryEntry>,
): FormulaMemoryEntry | null {
  if (!pattern) return null;
  const exact = list.find((e) => e.pattern === pattern);
  if (exact) return exact;

  let best: FormulaMemoryEntry | null = null;
  let bestScore = 0;
  for (const e of list) {
    const score = dice(pattern, e.pattern);
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  return bestScore >= SUGGEST_THRESHOLD ? best : null;
}

/**
 * Чистый редьюсер: добавить/обновить запись по `pattern` (переносится в
 * начало списка), дедуп по шаблону, кап `FORMULA_MEMORY_MAX`.
 */
export function addFormulaMemory(
  list: ReadonlyArray<FormulaMemoryEntry>,
  entry: FormulaMemoryEntry,
): FormulaMemoryEntry[] {
  return [entry, ...list.filter((e) => e.pattern !== entry.pattern)].slice(
    0,
    FORMULA_MEMORY_MAX,
  );
}

/** Прочитать историю из localStorage, терпя повреждённые/пустые данные. */
export function loadFormulaMemory(): FormulaMemoryEntry[] {
  try {
    const raw = localStorage.getItem(FORMULA_MEMORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (x): x is FormulaMemoryEntry =>
          x &&
          typeof x.pattern === 'string' &&
          x.pattern.length > 0 &&
          typeof x.label === 'string' &&
          typeof x.expression === 'string' &&
          x.expression.trim().length > 0 &&
          x.dependsOn &&
          typeof x.dependsOn === 'object',
      );
    }
  } catch {
    /* ignore — повреждённый JSON или недоступный storage */
  }
  return [];
}

/** Записать историю, проглатывая ошибки storage (private mode, quota). */
export function saveFormulaMemory(list: ReadonlyArray<FormulaMemoryEntry>): void {
  try {
    localStorage.setItem(FORMULA_MEMORY_KEY, JSON.stringify(list));
  } catch {
    /* ignore — storage недоступен */
  }
}
