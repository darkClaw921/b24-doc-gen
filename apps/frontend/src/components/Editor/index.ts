/**
 * Public re-exports for the Editor folder.
 *
 * Consumers can `import { TiptapEditor, Toolbar } from '@/components/Editor'`
 * without knowing the internal file layout.
 */

export { TiptapEditor, buildTiptapExtensions } from './TiptapEditor';
export type { TiptapEditorProps } from './TiptapEditor';
export { Toolbar } from './Toolbar';
export type { ToolbarProps } from './Toolbar';
