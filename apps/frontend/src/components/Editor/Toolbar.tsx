/**
 * Toolbar — formatting buttons for the TiptapEditor.
 *
 * Lives next to `TiptapEditor.tsx` so the editor can stay focused on
 * the editor instance and we can reuse the toolbar in other contexts
 * (e.g. a future template-preview screen).
 *
 * The toolbar talks to the editor via the `editor` prop (a TipTap
 * `Editor` instance returned from `useEditor`). All commands use the
 * standard `editor.chain().focus().<cmd>().run()` pattern.
 *
 * Buttons exposed:
 *  - Bold, Italic, Strike
 *  - Heading 1, Heading 2, Paragraph
 *  - Bullet list, Ordered list
 *  - Insert table (3x3 with header row), Insert image (URL prompt)
 *  - Undo, Redo
 */

import type { Editor } from '@tiptap/react';
import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Bold,
  Italic,
  Strikethrough,
  Heading1,
  Heading2,
  Pilcrow,
  List,
  ListOrdered,
  Table as TableIcon,
  Image as ImageIcon,
  Undo2,
  Redo2,
  Sigma,
  Package,
  ChevronDown,
  FormInput,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/** Column descriptors for the product table builder. */
interface ProductColumnOption {
  id: string;
  label: string;
  /** The data-product-field value, or special markers. */
  fieldOrMarker: string;
  /** Whether this column is selected by default. */
  defaultOn: boolean;
}

const PRODUCT_COLUMNS: ProductColumnOption[] = [
  { id: 'index', label: '# (номер)', fieldOrMarker: '__index__', defaultOn: true },
  { id: 'name', label: 'Название', fieldOrMarker: 'PRODUCT_NAME', defaultOn: true },
  { id: 'price', label: 'Цена', fieldOrMarker: 'PRICE', defaultOn: true },
  { id: 'quantity', label: 'Кол-во', fieldOrMarker: 'QUANTITY', defaultOn: true },
  { id: 'sum', label: 'Сумма', fieldOrMarker: 'SUM', defaultOn: true },
  { id: 'discount', label: 'Скидка', fieldOrMarker: 'DISCOUNT_SUM', defaultOn: false },
  { id: 'tax', label: 'НДС (%)', fieldOrMarker: 'TAX_RATE', defaultOn: false },
  { id: 'measure', label: 'Ед. изм.', fieldOrMarker: 'MEASURE_NAME', defaultOn: false },
  { id: 'image', label: 'Фото', fieldOrMarker: '__image__', defaultOn: false },
];

/**
 * Build product table HTML from the selected column set.
 */
function buildProductTableHtml(selectedIds: Set<string>): string {
  const cols = PRODUCT_COLUMNS.filter((c) => selectedIds.has(c.id));
  if (cols.length === 0) return '';

  const ths = cols
    .map((c) => `<th>${c.label}</th>`)
    .join('');

  const tds = cols
    .map((c) => {
      if (c.fieldOrMarker === '__index__') {
        return '<td><span data-product-index></span></td>';
      }
      if (c.fieldOrMarker === '__image__') {
        return '<td><span data-product-image="preview"></span></td>';
      }
      return `<td><span data-product-field="${c.fieldOrMarker}"></span></td>`;
    })
    .join('');

  return (
    `<table data-product-table="true">` +
    `<thead><tr>${ths}</tr></thead>` +
    `<tbody><tr>${tds}</tr></tbody>` +
    `</table>`
  );
}

/** Props for the toolbar. The `editor` may be null while loading. */
export interface ToolbarProps {
  editor: Editor | null;
  className?: string;
  /**
   * Called when the admin clicks the formula (Σ) button. The caller
   * is expected to open a FormulaBuilder dialog and, on submit,
   * invoke `editor.chain().focus().insertFormulaTag(attrs).run()`.
   * When omitted the button is hidden.
   */
  onInsertFormula?: () => void;
  /**
   * Called when the admin clicks the manual-field button. The caller is
   * expected to open a ManualFieldBuilder dialog and, on submit, invoke
   * `editor.chain().focus().insertManualFieldTag(attrs).run()`. When
   * omitted the button is hidden.
   */
  onInsertField?: () => void;
}

interface ButtonProps {
  onClick: () => void;
  isActive?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}

function ToolbarButton({ onClick, isActive, disabled, title, children }: ButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent',
        'text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
        'disabled:cursor-not-allowed disabled:opacity-50',
        isActive && 'bg-muted text-foreground border-border',
      )}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-6 w-px bg-border" aria-hidden />;
}

export function Toolbar({ editor, className, onInsertFormula, onInsertField }: ToolbarProps) {
  if (!editor) {
    return (
      <div
        className={cn(
          'flex h-10 items-center gap-1 rounded-md border border-input bg-background px-2 opacity-50',
          className,
        )}
      />
    );
  }

  const insertTable = () => {
    editor
      .chain()
      .focus()
      .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
      .run();
  };

  const insertImage = () => {
    // Simple prompt-based URL insertion. A future iteration can swap
    // this for a Bitrix24 disk picker.
    const url = window.prompt('URL картинки');
    if (url) {
      editor.chain().focus().setImage({ src: url }).run();
    }
  };

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-1 rounded-md border border-input bg-background px-2 py-1',
        className,
      )}
      role="toolbar"
      aria-label="Форматирование"
    >
      <ToolbarButton
        title="Жирный (Ctrl+B)"
        onClick={() => editor.chain().focus().toggleBold().run()}
        isActive={editor.isActive('bold')}
      >
        <Bold className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        title="Курсив (Ctrl+I)"
        onClick={() => editor.chain().focus().toggleItalic().run()}
        isActive={editor.isActive('italic')}
      >
        <Italic className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        title="Зачёркнутый"
        onClick={() => editor.chain().focus().toggleStrike().run()}
        isActive={editor.isActive('strike')}
      >
        <Strikethrough className="h-4 w-4" />
      </ToolbarButton>

      <Divider />

      <ToolbarButton
        title="Заголовок 1"
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        isActive={editor.isActive('heading', { level: 1 })}
      >
        <Heading1 className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        title="Заголовок 2"
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        isActive={editor.isActive('heading', { level: 2 })}
      >
        <Heading2 className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        title="Параграф"
        onClick={() => editor.chain().focus().setParagraph().run()}
        isActive={editor.isActive('paragraph')}
      >
        <Pilcrow className="h-4 w-4" />
      </ToolbarButton>

      <Divider />

      <ToolbarButton
        title="Маркированный список"
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        isActive={editor.isActive('bulletList')}
      >
        <List className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        title="Нумерованный список"
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        isActive={editor.isActive('orderedList')}
      >
        <ListOrdered className="h-4 w-4" />
      </ToolbarButton>

      <Divider />

      <ToolbarButton title="Таблица 3x3" onClick={insertTable}>
        <TableIcon className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton title="Картинка" onClick={insertImage}>
        <ImageIcon className="h-4 w-4" />
      </ToolbarButton>

      {onInsertFormula && (
        <>
          <Divider />
          <ToolbarButton title="Вставить формулу (Σ)" onClick={onInsertFormula}>
            <Sigma className="h-4 w-4" />
          </ToolbarButton>
        </>
      )}

      {onInsertField && (
        <ToolbarButton
          title="Вставить поле для ручного заполнения"
          onClick={onInsertField}
        >
          <FormInput className="h-4 w-4" />
        </ToolbarButton>
      )}

      <Divider />

      <ProductTableDropdown editor={editor} />

      <Divider />

      <ToolbarButton
        title="Отменить (Ctrl+Z)"
        onClick={() => editor.chain().focus().undo().run()}
        disabled={!editor.can().undo()}
      >
        <Undo2 className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        title="Повторить (Ctrl+Shift+Z)"
        onClick={() => editor.chain().focus().redo().run()}
        disabled={!editor.can().redo()}
      >
        <Redo2 className="h-4 w-4" />
      </ToolbarButton>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ProductTableDropdown                                                 */
/* ------------------------------------------------------------------ */

function ProductTableDropdown({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(PRODUCT_COLUMNS.filter((c) => c.defaultOn).map((c) => c.id)),
  );
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleInsert = useCallback(() => {
    const html = buildProductTableHtml(selected);
    if (!html) return;
    editor.chain().focus().insertContent(html).run();
    setOpen(false);
  }, [editor, selected]);

  const handleQuickInsert = useCallback(() => {
    const defaultIds = new Set(
      PRODUCT_COLUMNS.filter((c) => c.defaultOn).map((c) => c.id),
    );
    const html = buildProductTableHtml(defaultIds);
    if (!html) return;
    editor.chain().focus().insertContent(html).run();
  }, [editor]);

  return (
    <div className="relative" ref={dropdownRef}>
      <div className="flex">
        <button
          type="button"
          onClick={handleQuickInsert}
          title="Таблица товаров"
          className={cn(
            'inline-flex h-8 items-center justify-center rounded-l-md border border-transparent px-2',
            'text-emerald-700 transition-colors hover:bg-emerald-50 hover:text-emerald-800',
          )}
        >
          <Package className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => setOpen((p) => !p)}
          title="Выбрать колонки таблицы товаров"
          className={cn(
            'inline-flex h-8 w-5 items-center justify-center rounded-r-md border border-transparent',
            'text-emerald-700 transition-colors hover:bg-emerald-50 hover:text-emerald-800',
            open && 'bg-emerald-50',
          )}
        >
          <ChevronDown className="h-3 w-3" />
        </button>
      </div>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-md border border-border bg-background p-2 shadow-lg">
          <div className="mb-2 text-xs font-medium text-muted-foreground">
            Колонки таблицы товаров
          </div>
          {PRODUCT_COLUMNS.map((col) => (
            <label
              key={col.id}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted"
            >
              <input
                type="checkbox"
                checked={selected.has(col.id)}
                onChange={() => toggle(col.id)}
                className="h-3.5 w-3.5 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
              />
              {col.label}
            </label>
          ))}
          <div className="mt-2 border-t border-border pt-2">
            <button
              type="button"
              onClick={handleInsert}
              disabled={selected.size === 0}
              className={cn(
                'w-full rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white',
                'hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            >
              Вставить таблицу
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
