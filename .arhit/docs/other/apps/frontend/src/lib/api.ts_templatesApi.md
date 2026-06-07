# apps/frontend/src/lib/api.ts#templatesApi

Клиентский API-клиент шаблонов. Группа методов в объекте templatesApi в lib/api.ts.

## Методы
- list(params?): GET /api/templates — список шаблонов (фильтр themeId/search).
- get(id, { withDocx? }): GET /api/templates/:id — полный шаблон; при withDocx возвращает originalDocxBase64 + docxPlaceholders (теги из scanDocxPlaceholders) для редактора тегов.
- preview(id, dealId, fieldValues?, signal?): POST /api/templates/:id/preview — тело { dealId, fieldValues }, поддержка AbortSignal для debounce-отмены; возвращает TemplatePreviewResponseDTO ({ docxBase64, tags, formulas, fields }).
- create(body): POST /api/templates — создать пустой шаблон.
- update(id, body): PUT /api/templates/:id — обновить name/themeId + массивы formulas[]/fields[].
- delete(id): DELETE /api/templates/:id.
- upload({name, themeId, file}, opts?): POST /api/templates/upload через uploadRequest (multipart, XHR с прогрессом) — создание шаблона из нового .docx.
- saveDocx(id, docx: Blob, opts?): PUT /api/templates/:id/docx через uploadRequest с method: 'PUT' (multipart file='template.docx'). ЗАМЕНЯЕТ оригинальный .docx отредактированным из браузерного редактора @eigenpal/docx-editor-react (DocxEditorRef.save()). Backend пересканирует архив на плейсхолдеры и возвращает { template: TemplateDTO, docxPlaceholders: string[], warnings: string[] } с пересканированными тегами. Потребитель: TemplateEditorPage.handleSave (шаг 1 потока сохранения).

## uploadRequest хелпер
uploadRequest<T>(path, formData, opts) — XHR-upload с прогрессом для multipart. HTTP-метод берётся из opts.method ('POST' | 'PUT', по умолчанию 'POST'); UploadOptions расширен полем method чтобы один хелпер обслуживал и POST /templates/upload, и PUT /templates/:id/docx.

## Зависимости
- apiRequest<T>() / uploadRequest<T>() — низкоуровневые fetch/XHR wrappers с X-B24-* заголовками
- @b24-doc-gen/shared → Template-типы

## Потребители
- pages/TemplateEditorPage.tsx (get withDocx, saveDocx, update)
- pages/GeneratePage.tsx (preview)
- components/TemplateUploadDropzone.tsx (upload)
