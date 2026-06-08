# TemplateEditorPage

Hover-попап тегов в редакторе: overlay-пилюли template-плагина имеют класс .template-highlight (pointer-events:auto, без data-tag). mouseover на editorHostRef ловит .template-highlight, через requestAnimationFrame читает pluginHostRef.getPluginState('template').hoveredId + tags -> имя тега, ставит hoverInfo -> портальный TagHoverContent (формула/поле/reserved/unbound). pluginHostRef: useRef<PluginHostRef>. Подсветка: <PluginHost plugins={[templatePlugin]}> рисует renderOverlay как pluginOverlays. Кнопки вставки формул/полей в курсор через insertPlaceholderAtCursor.
