# apps/backend/src/routes/templates.ts

# templates.ts — CRUD маршруты шаблонов документов

## Назначение
REST API для управления шаблонами документов: создание, чтение, обновление, удаление, загрузка/замена .docx файлов, предпросмотр с данными сделки. Регистрируется через registerTemplateRoutes(app).

## Эндпоинты
- GET /api/templates?themeId=&search= — список шаблонов с фильтрацией (themeName + _count.formulas)
- GET /api/templates/:id?withDocx=1 — полный шаблон с формулами и ручными полями; при withDocx — base64 оригинала + docxPlaceholders (scanDocxPlaceholders) для панели тегов редактора
- POST /api/templates/:id/preview — предпросмотр: тело TemplatePreviewRequest { dealId, fieldValues? }; подставляет формулы+продукты+поля прямо в оригинальный .docx через buildDocxFromTemplate, возвращает TemplatePreviewResponse { docxBase64, tags, formulas, fields }
- POST /api/templates — создание пустого шаблона (requireAdmin)
- POST /api/templates/upload — multipart загрузка нового .docx (requireAdmin, max 20MB, валидация расширения/mime, парсинг docxParser, сохранение originalDocx)
- PUT /api/templates/:id/docx — multipart ЗАМЕНА оригинального .docx отредактированным из браузерного редактора (requireAdmin)
- PUT /api/templates/:id — транзакционное обновление name/themeId/contentHtml + замена массивов formulas и fields (deleteMany+createMany) (requireAdmin)
- DELETE /api/templates/:id — удаление formulas + fields + template (requireAdmin)

## PUT /api/templates/:id/docx (Phase 1 — фича редактирования .docx в браузере)
Зеркалит POST /api/templates/upload, но это ОБНОВЛЕНИЕ существующего шаблона (код 200, не 201):
1. requireAdmin preHandler; гард b24Auth.
2. prisma.template.findUnique({ where: { id } }) — если шаблона нет, reply.notFound (404).
3. Гард request.isMultipart() → badRequest если нет.
4. request.file({ limits: { fileSize: 20*1024*1024 } }); проверка наличия filePart.
5. Валидация .docx: /\.docx$/i.test(filename) || mimetype === application/vnd.openxmlformats-officedocument.wordprocessingml.document.
6. filePart.toBuffer(); проверка filePart.file.truncated → payloadTooLarge.
7. parseDocxToHtml(buffer) пересчитывает contentHtml (legacy/поиск; DocxParseError → badRequest).
8. scanDocxPlaceholders(buffer) — пересканирование тегов (non-fatal try/catch, при ошибке push warning).
9. prisma.template.update({ data: { originalDocx: buffer, contentHtml: html||'<p></p>' }, include: { formulas, fields } }).
10. reply.send({ template: toTemplateDto(row, false), warnings: messages, docxPlaceholders }).
Потребитель: frontend templatesApi.saveDocx (вызывается из TemplateEditorPage.handleSave после DocxEditorRef.save()).

## Сканирование плейсхолдеров
scanDocxPlaceholders(buffer) из docxTemplateEngine.ts вызывается в POST /upload, PUT /:id/docx и GET /:id?withDocx (через toTemplateDto). Возвращает имена тегов {placeholder} в .docx. Ошибки сканирования non-fatal → warnings.

## Ключевые типы
- TemplateListItemDTO — для списка (id, name, themeId, themeName, formulasCount, hasOriginalDocx, dates)
- TemplateDTO — полный шаблон (+ formulas[], fields[], originalDocxBase64?, docxPlaceholders?)
- FormulaInput, TemplateFieldInput — входные форматы от клиента

## Хелперы
- toTemplateDto(row, withDocx) — маппинг Prisma-строки в DTO; при withDocx добавляет originalDocxBase64 + docxPlaceholders
- toTemplateFieldDto, normalizeFieldsInput (валидация типа по белому списку, dedup по fieldKey, order, defaultValue)

## Особенности
- Мутации (POST/PUT/DELETE) защищены requireAdmin middleware (Phase 6)
- PUT /:id обновляет formulas/fields атомарно через Prisma transaction
- Preview использует ту же detectProductUsage логику что и generate.ts
- hasOriginalDocx поле в DTO указывает наличие оригинального .docx буфера

## Зависимости
- docxTemplateEngine.ts (scanDocxPlaceholders, buildDocxFromTemplate, DocxTemplateError)
- docxParser.ts (parseDocxToHtml, DocxParseError)
- formulaEngine.ts (evaluateExpression)
- generationPipeline.ts (resolveManualFieldValues)
- dealData.ts (getDealContext, DealDataError)
- middleware/role.ts (requireAdmin)
