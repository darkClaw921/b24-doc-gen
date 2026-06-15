/**
 * Pure helpers for editing `select` field options. Kept free of React /
 * UI imports so they can be unit-tested under `tsx --test` and reused by
 * both `SelectOptionsEditor` and any other caller.
 */

import type { SelectOptionDTO } from './api';

/**
 * Parse a pasted block of text into `select` options — one per non-empty
 * line.
 *
 * When `splitValue` is true (`mapped` mode) each line is split into a label
 * and a value by the FIRST tab or run of 2+ spaces: the part before is the
 * label (shown to the user), the part after is the value (substituted into
 * the document). A line with no such separator becomes a label-only option.
 *
 * When `splitValue` is false (`direct` mode) the whole line is the option —
 * no splitting, so values that contain double spaces stay intact.
 */
export function parseBulkOptions(text: string, splitValue: boolean): SelectOptionDTO[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      if (!splitValue) return { label: line, value: '' };
      const m = /^(.*?)(?:\t+|\s{2,})(.+)$/.exec(line);
      return m
        ? { label: m[1].trim(), value: m[2].trim() }
        : { label: line, value: '' };
    })
    .filter((o) => o.label.length > 0);
}

/**
 * Append freshly-parsed options to an existing list, dropping empty
 * placeholder rows and de-duplicating by trimmed label. Pure — returns a
 * new array. Shared by the bulk-paste action.
 */
export function mergeParsedOptions(
  existing: SelectOptionDTO[],
  parsed: SelectOptionDTO[],
): SelectOptionDTO[] {
  const kept = existing.filter((o) => o.label.trim().length > 0);
  const seen = new Set(kept.map((o) => o.label.trim()));
  const merged = [...kept];
  for (const o of parsed) {
    if (seen.has(o.label)) continue;
    seen.add(o.label);
    merged.push(o);
  }
  return merged;
}
