/**
 * ProductTableNode — custom TipTap extension that visually distinguishes
 * product tables (`<table data-product-table="true">`) from regular tables.
 *
 * Why it exists:
 *  - Product tables are structurally identical to normal HTML tables, but
 *    they carry a `data-product-table="true"` attribute that the backend
 *    `docxBuilder.expandProductTables()` uses to clone rows per product.
 *  - In the WYSIWYG editor we want admins to immediately see which table
 *    is a product template (colored border + badge) vs. a regular table.
 *
 * Implementation approach:
 *  - We do NOT replace the built-in TipTap Table node. Instead we extend
 *    the existing Table node with an extra `productTable` attribute.
 *  - When `data-product-table="true"` is present on a `<table>`, the
 *    attribute is parsed and stored. The renderHTML method appends an
 *    extra CSS class `product-table` that global styles can target.
 *
 * We also export a `ProductFieldSpan` inline atom node for
 * `<span data-product-field="FIELD">` elements inside product tables.
 * These render as small pills showing the field name.
 *
 * And a `ProductImageSpan` inline atom node for
 * `<span data-product-image="true">` placeholders.
 *
 * And a `ProductIndexSpan` inline atom node for
 * `<span data-product-index>` (row number placeholder).
 */

import { Node, mergeAttributes, type RawCommands } from '@tiptap/core';

/* ------------------------------------------------------------------ */
/* ProductFieldSpan — atom pill for product field placeholders          */
/* ------------------------------------------------------------------ */

export const ProductFieldSpan = Node.create({
  name: 'productFieldSpan',

  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      field: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-product-field') ?? '',
        renderHTML: (attrs: { field?: string }) => ({
          'data-product-field': attrs.field ?? '',
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-product-field]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const field = String(node.attrs.field ?? '');
    const merged = mergeAttributes(HTMLAttributes, {
      class:
        'product-field-pill inline-flex items-center rounded bg-emerald-100 px-1.5 py-0.5 ' +
        'text-xs font-medium text-emerald-800 ring-1 ring-inset ring-emerald-300 ' +
        'cursor-default',
      contenteditable: 'false',
    });
    return ['span', merged, field || 'FIELD'];
  },
});

/* ------------------------------------------------------------------ */
/* ProductImageSpan — atom pill for product image placeholders          */
/* ------------------------------------------------------------------ */

export const ProductImageSpan = Node.create({
  name: 'productImageSpan',

  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      productImage: {
        default: 'true',
        parseHTML: () => 'true',
        renderHTML: () => ({ 'data-product-image': 'true' }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-product-image]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const merged = mergeAttributes(HTMLAttributes, {
      class:
        'product-image-pill inline-flex items-center rounded bg-purple-100 px-1.5 py-0.5 ' +
        'text-xs font-medium text-purple-800 ring-1 ring-inset ring-purple-300 ' +
        'cursor-default',
      contenteditable: 'false',
    });
    return ['span', merged, '\u{1F5BC} Фото'];
  },
});

/* ------------------------------------------------------------------ */
/* ProductIndexSpan — atom pill for row number placeholders             */
/* ------------------------------------------------------------------ */

export const ProductIndexSpan = Node.create({
  name: 'productIndexSpan',

  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      productIndex: {
        default: 'true',
        parseHTML: () => 'true',
        renderHTML: () => ({ 'data-product-index': '' }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-product-index]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const merged = mergeAttributes(HTMLAttributes, {
      class:
        'product-index-pill inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 ' +
        'text-xs font-medium text-gray-700 ring-1 ring-inset ring-gray-300 ' +
        'cursor-default',
      contenteditable: 'false',
    });
    return ['span', merged, '#'];
  },
});
