# GeneratePage

Preview+генерация. Preview через docx-preview renderAsync. После рендера applyPreviewHighlights(body) обходит текстовые узлы TreeWalker и заменяет sentinel-пары PREVIEW_HIGHLIGHT_MARKERS (которыми preview-endpoint обернул подставленные значения) на span: формулы (авто из сделки) янтарный .gen-formula-hl, ручные поля голубой .gen-field-hl (CSS PREVIEW_HL_STYLES). Подсветка только в preview, в скачиваемом .docx маркеров нет. Форма ручных полей с debounce-перезапросом preview.
