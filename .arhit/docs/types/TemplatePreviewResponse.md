# TemplatePreviewResponse

Response body для POST /api/templates/:id/preview. Новый shape (Фаза 2): docxBase64: string — подставленный .docx предпросмотра, base64-кодированный (рендерится фронтом через docx-preview); tags: string[] — плейсхолдеры из scanDocxPlaceholders(originalDocx) для подсветки/привязки; formulas: Record<string, FormulaEvaluationResult> — результаты вычисления формул по tagKey; fields: TemplateField[] — ручные поля. Заменил прежнее поле html: string (server-rendered HTML preview удалён). Контракт между frontend (Фаза 3 GeneratePage/docx-preview) и backend preview-endpoint.
