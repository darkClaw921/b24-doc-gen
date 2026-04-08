/**
 * FormulaTag — a custom TipTap inline node that represents a formula
 * placeholder inside a template.
 *
 * Why it exists:
 *  - Admins insert formulas into the template body while editing.
 *  - We need an atomic DOM element that survives round-trips through
 *    mammoth (`.docx` → HTML) and back, without the user accidentally
 *    breaking it with arbitrary formatting.
 *  - The rendered element is a single `<span>` carrying three data
 *    attributes the preview pipeline reads:
 *      data-formula-key        — unique key inside the template
 *      data-formula-label      — human-readable label shown in edit mode
 *      data-formula-expression — the raw mathjs expression (read-only)
 *
 * Behaviour:
 *  - In edit mode the span renders the label (so admins see something
 *    meaningful while authoring).
 *  - In preview mode (not implemented in this file) the parent can
 *    swap the spans for their evaluated values before rendering.
 *  - The node is `inline: true` + `atom: true`, which makes TipTap
 *    treat it as a non-selectable character and prevents the caret
 *    from entering it. This matches the UX of mention/tag pills in
 *    the TipTap docs.
 *
 * Public API:
 *  - Default export `FormulaTag` is the Node extension passed to
 *    `extensions: []` on `useEditor`.
 *  - `insertFormula(editor, attrs)` helper is exposed so the toolbar
 *    can drop a new tag at the caret without going through the
 *    commands API directly.
 *  - The extension also registers a TipTap command of the same name
 *    so `editor.chain().focus().insertFormula(attrs).run()` works.
 *
 * The parseHTML rule recognises any `<span data-formula-key="…">` so
 * templates round-trip cleanly through saving and re-loading.
 */

import { Node, mergeAttributes, type RawCommands } from '@tiptap/core';
import type { Editor } from '@tiptap/react';

/** Attributes stored on a FormulaTag node and mirrored to the DOM. */
export interface FormulaTagAttributes {
  /** Unique key inside a template. Used to join with the Formula row. */
  tagKey: string;
  /** Human-readable label shown inside the pill while editing. */
  label: string;
  /** mathjs expression the server will evaluate for previews/generation. */
  expression: string;
}

/**
 * Extend TipTap's command record so TS sees the new command.
 */
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    formulaTag: {
      /** Insert a new FormulaTag at the current caret position. */
      insertFormulaTag: (attrs: FormulaTagAttributes) => ReturnType;
    };
  }
}

/** Default attributes for safety fall-backs. */
const DEFAULTS: FormulaTagAttributes = {
  tagKey: '',
  label: '',
  expression: '',
};

/**
 * The TipTap Node extension. Register it in the editor's `extensions`
 * array right after `StarterKit`.
 */
export const FormulaTag = Node.create({
  name: 'formulaTag',

  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      tagKey: {
        default: DEFAULTS.tagKey,
        parseHTML: (el) => el.getAttribute('data-formula-key') ?? '',
        renderHTML: (attrs: { tagKey?: string }) => ({
          'data-formula-key': attrs.tagKey ?? '',
        }),
      },
      label: {
        default: DEFAULTS.label,
        parseHTML: (el) => el.getAttribute('data-formula-label') ?? '',
        renderHTML: (attrs: { label?: string }) => ({
          'data-formula-label': attrs.label ?? '',
        }),
      },
      expression: {
        default: DEFAULTS.expression,
        parseHTML: (el) => el.getAttribute('data-formula-expression') ?? '',
        renderHTML: (attrs: { expression?: string }) => ({
          'data-formula-expression': attrs.expression ?? '',
        }),
      },
    };
  },

  /**
   * Recognise our own markup plus a permissive match for any element
   * tagged `data-formula-key` so templates imported from mammoth or a
   * previous version of the editor still parse.
   */
  parseHTML() {
    return [
      {
        tag: 'span[data-formula-key]',
      },
    ];
  },

  /**
   * Render as a single span. The display text is the label so the
   * editor shows something meaningful; the tooltip (title) shows the
   * underlying expression for quick inspection.
   */
  renderHTML({ HTMLAttributes, node }) {
    const label = String(node.attrs.label ?? '');
    const expression = String(node.attrs.expression ?? '');
    const merged = mergeAttributes(HTMLAttributes, {
      class:
        'formula-tag inline-flex items-center rounded bg-blue-100 px-1.5 py-0.5 ' +
        'text-xs font-medium text-blue-800 ring-1 ring-inset ring-blue-300 ' +
        'cursor-pointer hover:bg-blue-200',
      title: expression || label || 'formula',
      contenteditable: 'false',
    });
    return ['span', merged, `Σ ${label || 'formula'}`];
  },

  addCommands() {
    return {
      insertFormulaTag:
        (attrs: FormulaTagAttributes) =>
        ({ chain }) => {
          // Insert a node of our type at the caret.
          return chain()
            .insertContent({
              type: this.name,
              attrs: {
                tagKey: attrs.tagKey,
                label: attrs.label,
                expression: attrs.expression,
              },
            })
            .run();
        },
    } as Partial<RawCommands>;
  },
});

/**
 * Imperative helper for callers that prefer not to touch the chain
 * API directly. Inserts a FormulaTag at the current caret and returns
 * the result of the command (boolean). No-op when the editor is null.
 */
export function insertFormula(editor: Editor | null, attrs: FormulaTagAttributes): boolean {
  if (!editor) return false;
  return editor.chain().focus().insertFormulaTag(attrs).run();
}

export default FormulaTag;
