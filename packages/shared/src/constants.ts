/**
 * Shared runtime constants for the b24-doc-gen monorepo.
 *
 * Kept separate from `types.ts` (which must remain a pure type-only module).
 */

/**
 * Private-use Unicode sentinels the **preview** endpoint wraps substituted
 * values in, so the GeneratePage preview can colour-highlight where data came
 * from (formula = auto from the deal, manual field = user-entered). They are
 * invisible code points, survive the docx-preview render as plain text, and the
 * client strips them while wrapping the inner text in a styled `<span>`.
 *
 * IMPORTANT: only the preview path uses these — the downloadable/generated
 * `.docx` is built without markers, so the final document has no highlighting.
 * Single source of truth shared by `routes/templates.ts` (wrap) and
 * `GeneratePage.tsx` (strip + highlight).
 */
export const PREVIEW_HIGHLIGHT_MARKERS = {
  /** Wraps a formula-substituted value (auto-resolved from the deal). */
  formulaStart: "\uE000",
  formulaEnd: "\uE001",
  /** Wraps a manual-field value (entered by the user). */
  fieldStart: "\uE002",
  fieldEnd: "\uE003",
} as const;
