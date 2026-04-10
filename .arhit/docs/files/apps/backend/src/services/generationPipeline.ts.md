# apps/backend/src/services/generationPipeline.ts

# generationPipeline.ts — Shared пайплайн генерации документов

## Назначение
Framework-agnostic ядро генерации .docx. Извлечён из routes/generate.ts чтобы несколько точек входа (POST /api/generate, bizproc robot, outgoing webhook) могли использовать одну и ту же логику без дублирования и без зависимости от Fastify request/reply.

## Ветвящаяся логика генерации (Phase 5)
В шаге 4 пайплайна реализована ветка выбора движка:
- Если template.originalDocx !== null → buildDocxFromTemplate() из docxTemplateEngine.ts
- Иначе → buildDocxFromHtml() из docxBuilder.ts
Обе ветки обрабатывают ошибки: DocxBuildError и DocxTemplateError оборачиваются в GenerationError('docx_build_failed').

## Валидация плейсхолдеров (Phase 5, шаг 3b)
Перед генерацией, если шаблон имеет originalDocx, scanDocxPlaceholders() проверяет соответствие tagKey формул плейсхолдерам в .docx. Несовпадения → warnings (non-fatal).

## Ключевые экспорты
- runGeneration(params: RunGenerationParams): Promise<GenerationResult> — основная функция
- GenerationResult — extends GenerateResponse: fileName, formulas, binding, timeline, warnings
- GenerationError — класс ошибки с kind: GenerationErrorKind
- GenerationErrorKind — union type: template_not_found | bad_deal_id | deal_not_found | deal_gateway | docx_build_failed | disk_gateway | upload_failed | unexpected
- BindingResult — { fieldName, ok, error? }
- RunGenerationParams — { templateId, dealId, client: B24Client, logger }

## Пайплайн (9 шагов)
1. Загрузка шаблона + формул + theme из Prisma
2. Определение необходимости товарных данных (detectProductUsage)
3. Построение контекста сделки
3b. Валидация тегов формул против плейсхолдеров .docx
4. Генерация .docx (ветвящаяся логика)
5. disk.storage.getforapp → folder id
6. disk.folder.uploadfile
7. Опциональная привязка UF_CRM_*
8. Опциональный timeline comment
9. Возврат результата

## Импорты из docxTemplateEngine
- buildDocxFromTemplate, DocxTemplateError, scanDocxPlaceholders

## Отличие от generate.ts
- Не зависит от Fastify (принимает logger как параметр)
- Ошибки оборачиваются в GenerationError вместо reply.badRequest/notFound
- Используется webhook runner и bizproc robot handler
