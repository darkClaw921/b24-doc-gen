/**
 * TiptapEditor — WYSIWYG editor used by the template editor page.
 *
 * Built on TipTap (a ProseMirror wrapper). The editor is configured
 * with the canonical bundle for this project:
 *
 *   - StarterKit         — paragraphs, headings, lists, bold/italic,
 *                          history, code, blockquote, hard break.
 *   - Image              — `<img>` nodes (inline + base64 allowed so
 *                          docx pictures parsed by mammoth render).
 *   - Table family       — Table + TableRow + TableHeader + TableCell,
 *                          with column resizing enabled.
 *
 * The component is purely controlled: parents pass `content` (initial
 * HTML) and `onChange` (called with the latest HTML). When the parent
 * swaps `content` with a different HTML string the editor re-syncs via
 * `editor.commands.setContent`. We deliberately *do not* re-sync on
 * every keystroke to avoid an infinite loop with parent-side state.
 *
 * The companion `Toolbar` component lives next door and renders the
 * formatting buttons. The page composes them together so callers can
 * mount the toolbar wherever they like (sticky header, sidebar, …).
 */

import { useEffect } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import { Image } from '@tiptap/extension-image';
import {
  Table,
  TableRow,
  TableHeader,
  TableCell,
} from '@tiptap/extension-table';
import { FormulaTag } from '@/components/FormulaTag';
import { cn } from '@/lib/utils';

export interface TiptapEditorProps {
  /** Initial HTML content. Parents may update this when loading data. */
  content: string;
  /** Called with the new HTML on every change. Stable identity helps. */
  onChange?: (html: string) => void;
  /** Optional ref-style callback exposing the underlying Editor. */
  onReady?: (editor: Editor) => void;
  /** When true, disables editing (preview mode). */
  editable?: boolean;
  /** Extra classes applied to the editor wrapper. */
  className?: string;
  /** Placeholder shown via tailwind CSS when the document is empty. */
  placeholder?: string;
}

/**
 * Build the canonical TipTap extensions list. Exported so other
 * editors (e.g. a future preview/read-only view) can reuse the
 * exact same configuration.
 */
export function buildTiptapExtensions() {
  return [
    StarterKit.configure({
      // Heading levels we surface in the toolbar.
      heading: { levels: [1, 2, 3] },
    }),
    Image.configure({
      inline: false,
      allowBase64: true,
      HTMLAttributes: {
        class: 'tiptap-image',
      },
    }),
    Table.configure({
      resizable: true,
      HTMLAttributes: {
        class: 'tiptap-table',
      },
    }),
    TableRow,
    TableHeader,
    TableCell,
    // Inline atom node used to embed formula placeholders. Admins
    // insert these via the FormulaBuilder dialog; they are rendered
    // as styled `<span data-formula-key>` pills and picked up by the
    // server-side preview/generation pipeline.
    FormulaTag,
  ];
}

export function TiptapEditor({
  content,
  onChange,
  onReady,
  editable = true,
  className,
  placeholder,
}: TiptapEditorProps) {
  const editor = useEditor({
    extensions: buildTiptapExtensions(),
    content,
    editable,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: cn(
          'tiptap-content max-w-none focus:outline-none',
          'min-h-[400px] px-4 py-3',
          !editable && 'opacity-90',
        ),
        ...(placeholder ? { 'data-placeholder': placeholder } : {}),
      },
    },
    onUpdate: ({ editor: ed }) => {
      onChange?.(ed.getHTML());
    },
  });

  // Notify parent once the editor is created.
  useEffect(() => {
    if (editor && onReady) onReady(editor);
  }, [editor, onReady]);

  // Re-sync when the parent feeds in a *different* HTML string.
  // We compare against the current editor content to avoid loops.
  useEffect(() => {
    if (!editor) return;
    const current = editor.getHTML();
    if (content !== current) {
      editor.commands.setContent(content || '<p></p>', { emitUpdate: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, editor]);

  // Toggle editable mode when the prop changes (e.g. preview).
  useEffect(() => {
    if (!editor) return;
    if (editor.isEditable !== editable) {
      editor.setEditable(editable);
    }
  }, [editor, editable]);

  return (
    <div
      className={cn(
        'rounded-md border border-input bg-background',
        'focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2',
        className,
      )}
    >
      <EditorContent editor={editor} />
    </div>
  );
}
