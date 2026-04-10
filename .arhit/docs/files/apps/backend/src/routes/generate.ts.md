# apps/backend/src/routes/generate.ts

# generate.ts — Маршрут генерации документов

## Назначение
HTTP-эндпоинт POST /api/generate — генерирует .docx документ из шаблона с данными сделки Bitrix24, загружает на диск, опционально привязывает к сделке и добавляет комментарий в таймлайн.

## Ветвящаяся логика генерации (Phase 5)
В шаге 5 пайплайна реализована ветка выбора движка:
- Если template.originalDocx !== null → используется buildDocxFromTemplate() из docxTemplateEngine.ts (прямая подстановка в .docx, сохраняет оригинальное форматирование)
- Иначе → используется buildDocxFromHtml() из docxBuilder.ts (HTML → .docx конвертация)

## Валидация плейсхолдеров (Phase 5, шаг 4b)
Перед генерацией, если шаблон имеет originalDocx, вызывается scanDocxPlaceholders() для проверки что каждый tagKey из формул имеет соответствующий плейсхолдер в .docx. Несовпадения логируются как warnings (non-fatal).

## Пайплайн (10 шагов)
1. Загрузка шаблона + формул из Prisma
2. Определение необходимости загрузки товарных данных (detectProductUsage)
3. Построение контекста сделки через getDealContext
4. Вычисление формул
4b. Валидация тегов формул против плейсхолдеров .docx (non-fatal warnings)
5. Генерация .docx (ветвящаяся логика: docxTemplateEngine или docxBuilder)
6. disk.storage.getforapp → ID папки
7. disk.folder.uploadfile → загрузка файла
8. Опциональная привязка к UF_CRM_* полю через crm.item.update
9. Опциональный комментарий в таймлайн через crm.timeline.comment.add
10. Ответ с результатами

## Импорты из docxTemplateEngine
- buildDocxFromTemplate — основная функция генерации из .docx шаблона
- DocxTemplateError — обрабатывается в catch блоке шага 5
- scanDocxPlaceholders — валидация плейсхолдеров в шаге 4b

## Ключевые типы
- GenerateBody: { templateId: string, dealId: number|string }
- GenerateRouteResponse: extends GenerateResponse — fileId, downloadUrl, fileName, formulas, binding, timeline, warnings
- BindingResult: { fieldName, ok, error? }

## Зависимости
- docxTemplateEngine.ts (buildDocxFromTemplate, DocxTemplateError, scanDocxPlaceholders)
- docxBuilder.ts (buildDocxFromHtml, DocxBuildError)
- dealData.ts (getDealContext)
- formulaEngine.ts (evaluateExpression)
- b24Client.ts (B24Client, B24Error)
- install.ts (toAppSettings)
