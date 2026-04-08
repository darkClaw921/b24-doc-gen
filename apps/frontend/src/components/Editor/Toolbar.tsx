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
} from 'lucide-react';
import { cn } from '@/lib/utils';

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

export function Toolbar({ editor, className, onInsertFormula }: ToolbarProps) {
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
