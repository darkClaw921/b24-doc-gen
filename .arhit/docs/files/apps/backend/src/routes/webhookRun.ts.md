# apps/backend/src/routes/webhookRun.ts

Публичный исполнительный endpoint, который Bitrix24 bizproc-робот «Исходящий вебхук» POST'ит при переходе сделки в настроенную стадию.

## Назначение
Единственная точка входа, вызываемая автоматизацией Bitrix24 (CRM → Автоматизация → Роботы → «Исходящий вебхук»). Принимает весь Bitrix outbound payload в формате application/x-www-form-urlencoded, валидирует его и запускает тот же generation pipeline, что и UI-кнопка «Сгенерировать документ».

## Маршрут
POST /api/webhook/run/:token

Content-Type: application/x-www-form-urlencoded (парсится @fastify/formbody с qs.parse для nested brackets auth[...]/document_id[...]).

## Публичность
Роут находится в PUBLIC_PATHS (middleware/auth.ts), поэтому глобальный B24-middleware его не гейтит. Аутентификация происходит через:
1. URL :token (лукап Webhook в БД)
2. Сверка body.auth.application_token с AppSettings.applicationToken (shared secret портала)

## Шаги исполнения
1. Лукап prisma.webhook.findUnique({token}) → 404 если нет или enabled=false.
2. Валидация AppSettings.applicationToken → 401 если не настроен или mismatch с body.auth.application_token (принимает snake_case и camelCase alias).
3. parseDealIdFromDocumentId(body.document_id[2]) — регулярки /^DEAL_(\d+)$/i и /^DEAL_(?:FLEXIBLE|FLEXABLE)_(\d+)_(\d+)$/i → 400 при неизвестном формате.
4. Извлечение auth.access_token + auth.domain → 400 если отсутствуют, создание нового B24Client.
5. Resolve списка templateIds из webhook.scope:
   - 'template' → [webhook.templateId]
   - 'theme' → prisma.template.findMany({themeId: webhook.themeId}, orderBy: createdAt asc).
6. Sequential loop по templateIds: runGeneration({templateId, dealId, client, logger}) из services/generationPipeline.ts. Каждый шаблон в отдельном try/catch — ошибка одного НЕ прерывает остальных. Ловятся GenerationError (с полем kind), B24Error (с code), unknown (errorKind='unexpected'). Счётчики generated/failed + results[].
7. Best-effort prisma.webhook.update({useCount: {increment:1}, lastUsedAt: new Date()}) — ошибка логгируется как warn.
8. Опциональный ack: если body.event_token присутствует — fire-and-forget client.callMethod('bizproc.event.send', {event_token, return_values: {}}). Ошибки ack'а не превращаются в 500.
9. Ответ JSON: {ok: failed===0, dealId, generated, failed, results[]}.

## Хелперы
- readDocumentIdEntry(documentId, index): нормализует qs-вариации (Array vs объект с числовыми ключами при разреженных индексах).
- parseDealIdFromDocumentId(value): экспортируется для юнит-тестов. Поддерживает DEAL_<id> и DEAL_FLEXIBLE_<typeId>_<id> (+FLEXABLE defensive).
- pickString(...values): первое непустое string после trim.
- summariseSuccess(templateId, result): маппинг GenerationResult → TemplateRunResult (не тянет полную formula map — робот-caller её не использует).
- sendBizprocAck(client, eventToken, logger): try/catch с warn на failure.

## Зависимости
- prisma.webhook, prisma.template, prisma.appSettings
- services/b24Client.ts → B24Client, B24Error
- services/generationPipeline.ts → runGeneration, GenerationError, GenerationResult

## Обработка ошибок (коды)
- 404 — webhook not found ИЛИ enabled=false (скрываем существование)
- 401 — application_token mismatch или AppSettings.applicationToken не настроен
- 400 — document_id[2] невалидный ИЛИ auth.access_token/domain отсутствуют
- 200 с {ok:false, failed:N, results:[...]} — шаблоны не сгенерированы, но сам вызов успешен
- 500 — конфигурационная ошибка webhook'а (scope/template mismatch) или непредвиденный throw
