# apps/backend/src/routes/templates.ts

# templates.ts — CRUD маршруты шаблонов документов

## Назначение
REST API для управления шаблонами документов: создание, чтение, обновление, удаление, загрузка .docx файлов, предпросмотр с данными сделки.

## Эндпоинты
- GET /api/templates?themeId=&search= — список шаблонов с фильтрацией
- GET /api/templates/:id — полный шаблон с формулами (?withDocx=1 для base64 .docx)
- GET /api/templates/:id/preview?dealId= — предпросмотр с подставленными данными сделки
- POST /api/templates — создание пустого шаблона (requireAdmin)
- POST /api/templates/upload — multipart загрузка .docx (requireAdmin)
- PUT /api/templates/:id — обновление шаблона и формул (requireAdmin)
- DELETE /api/templates/:id — удаление шаблона (requireAdmin)

## Сканирование плейсхолдеров при загрузке (Phase 5)
В POST /api/templates/upload после конвертации .docx → HTML вызывается scanDocxPlaceholders(buffer) из docxTemplateEngine.ts. Результат возвращается клиенту в поле docxPlaceholders[] ответа. Ошибки сканирования non-fatal — добавляются в warnings.

## Импорты из docxTemplateEngine
- scanDocxPlaceholders — используется в POST /api/templates/upload

## Ключевые типы
- TemplateListItemDTO — для списка (id, name, themeId, themeName, formulasCount, hasOriginalDocx, dates)
- TemplateDTO — полный шаблон (+ formulas[], originalDocxBase64?)
- FormulaInput — входной формат формулы от клиента (tagKey, label, expression, dependsOn)

## Особенности
- Мутации (POST/PUT/DELETE) защищены requireAdmin middleware
- PUT обновляет формулы атомарно через Prisma transaction (deleteMany + createMany)
- Preview использует ту же detectProductUsage логику что и generate.ts
- substituteFormulaTagsForPreview() подставляет вычисленные значения в span[data-formula-key] элементы HTML
- hasOriginalDocx поле в DTO указывает наличие оригинального .docx буфера

## Зависимости
- docxTemplateEngine.ts (scanDocxPlaceholders)
- docxParser.ts (parseDocxToHtml)
- formulaEngine.ts (evaluateExpression)
- docxBuilder.ts (expandProductTables)
- dealData.ts (getDealContext)
- b24Client.ts (B24Client)
- middleware/role.ts (requireAdmin)
