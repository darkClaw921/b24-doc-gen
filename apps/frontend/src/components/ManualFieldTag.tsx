/**
 * ManualFieldTag — a custom TipTap inline node that represents a manual
 * field placeholder inside a template.
 *
 * Why it exists:
 *  - Unlike a FormulaTag (whose value is computed from CRM data), a
 *    manual field is filled in by the *user* at generation time.
 *  - Admins drop these placeholders into the template body while
 *    editing; at generation the GeneratePage renders a form for them
 *    and substitutes the entered values into the document.
 *  - The rendered element is a single `<span>` carrying data attributes
 *    the preview / generation pipeline reads:
 *      data-field-key         — unique key inside the template
 *      data-field-label       — human-readable label
 *      data-field-type        — text | textarea | number | date
 *      data-field-required    — "true" | "false"
 *      data-field-placeholder — optional hint
 *
 * The node mirrors FormulaTag's shape (inline + atom, non-editable
 * pill) so it round-trips cleanly through save/reload. The parseHTML
 * rule recognises any `<span data-field-key="…">`.
 */

import { Node, mergeAttributes, type RawCommands } from '@tiptap/core';
import type { Editor } from '@tiptap/react';

/** Attributes stored on a ManualFieldTag node and mirrored to the DOM. */
export interface ManualFieldTagAttributes {
  /** Unique key inside a template. Joins with the TemplateField row. */
  fieldKey: string;
  /** Human-readable label shown inside the pill and the generate form. */
  label: string;
  /** Control type rendered in the generate form. */
  type: string;
  /** Whether the user must fill the field before generating. */
  required: boolean;
  /** Optional hint shown inside the empty input. */
  placeholder: string;
  /** Default-value token (e.g. "today" for date fields). */
  defaultValue: string;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    manualFieldTag: {
      /** Insert a new ManualFieldTag at the current caret position. */
      insertManualFieldTag: (attrs: ManualFieldTagAttributes) => ReturnType;
    };
  }
}

const DEFAULTS: ManualFieldTagAttributes = {
  fieldKey: '',
  label: '',
  type: 'text',
  required: false,
  placeholder: '',
  defaultValue: '',
};

export const ManualFieldTag = Node.create({
  name: 'manualFieldTag',

  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      fieldKey: {
        default: DEFAULTS.fieldKey,
        parseHTML: (el) => el.getAttribute('data-field-key') ?? '',
        renderHTML: (attrs: { fieldKey?: string }) => ({
          'data-field-key': attrs.fieldKey ?? '',
        }),
      },
      label: {
        default: DEFAULTS.label,
        parseHTML: (el) => el.getAttribute('data-field-label') ?? '',
        renderHTML: (attrs: { label?: string }) => ({
          'data-field-label': attrs.label ?? '',
        }),
      },
      type: {
        default: DEFAULTS.type,
        parseHTML: (el) => el.getAttribute('data-field-type') ?? 'text',
        renderHTML: (attrs: { type?: string }) => ({
          'data-field-type': attrs.type ?? 'text',
        }),
      },
      required: {
        default: DEFAULTS.required,
        parseHTML: (el) => el.getAttribute('data-field-required') === 'true',
        renderHTML: (attrs: { required?: boolean }) => ({
          'data-field-required': attrs.required ? 'true' : 'false',
        }),
      },
      placeholder: {
        default: DEFAULTS.placeholder,
        parseHTML: (el) => el.getAttribute('data-field-placeholder') ?? '',
        renderHTML: (attrs: { placeholder?: string }) => ({
          'data-field-placeholder': attrs.placeholder ?? '',
        }),
      },
      defaultValue: {
        default: DEFAULTS.defaultValue,
        parseHTML: (el) => el.getAttribute('data-field-default') ?? '',
        renderHTML: (attrs: { defaultValue?: string }) => ({
          'data-field-default': attrs.defaultValue ?? '',
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-field-key]',
      },
    ];
  },

  /**
   * Render as a single amber pill so admins can distinguish manual
   * fields from formula (blue) and product (emerald) pills at a glance.
   * The "✎" glyph hints that it is hand-filled; a "*" marks required.
   */
  renderHTML({ HTMLAttributes, node }) {
    const label = String(node.attrs.label ?? '');
    const required = Boolean(node.attrs.required);
    const merged = mergeAttributes(HTMLAttributes, {
      class:
        'manual-field-tag inline-flex items-center rounded bg-amber-100 px-1.5 py-0.5 ' +
        'text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-300 ' +
        'cursor-pointer hover:bg-amber-200',
      title: required ? `${label || 'поле'} (обязательное)` : label || 'поле',
      contenteditable: 'false',
    });
    return ['span', merged, `✎ ${label || 'поле'}${required ? ' *' : ''}`];
  },

  addCommands() {
    return {
      insertManualFieldTag:
        (attrs: ManualFieldTagAttributes) =>
        ({ chain }) => {
          return chain()
            .insertContent({
              type: this.name,
              attrs: {
                fieldKey: attrs.fieldKey,
                label: attrs.label,
                type: attrs.type,
                required: attrs.required,
                placeholder: attrs.placeholder,
                defaultValue: attrs.defaultValue,
              },
            })
            .run();
        },
    } as Partial<RawCommands>;
  },
});

/**
 * Imperative helper that inserts a ManualFieldTag at the caret. No-op
 * when the editor is null.
 */
export function insertManualField(
  editor: Editor | null,
  attrs: ManualFieldTagAttributes,
): boolean {
  if (!editor) return false;
  return editor.chain().focus().insertManualFieldTag(attrs).run();
}

export default ManualFieldTag;
