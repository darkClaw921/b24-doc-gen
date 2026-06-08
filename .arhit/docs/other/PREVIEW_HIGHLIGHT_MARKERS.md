# PREVIEW_HIGHLIGHT_MARKERS

Невидимые sentinel-символы приватной Unicode-зоны (U+E000..U+E003: formulaStart/End, fieldStart/End) в packages/shared/src/constants.ts. Preview-endpoint (routes/templates.ts) оборачивает ими подставленные значения формул/полей; GeneratePage.applyPreviewHighlights заменяет пары на подсвеченные span. Только для preview — в генерируемом .docx маркеров нет.
