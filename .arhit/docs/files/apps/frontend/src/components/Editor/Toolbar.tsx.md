# apps/frontend/src/components/Editor/Toolbar.tsx

Тулбар форматирования для TiptapEditor. Принимает editor: Editor | null. Кнопки (lucide-react иконки): Bold/Italic/Strike, Heading 1/2/Paragraph, BulletList/OrderedList, вставка таблицы 3x3 с header row (insertTable), вставка картинки через window.prompt URL, undo/redo (с editor.can().undo()/redo() для disabled). Состояние активного форматирования через editor.isActive('bold' | 'heading' { level: 1 } | ...). Внутренний ToolbarButton рендерит button с aria-label, hover-стилями и disabled. Стилизация Tailwind.
