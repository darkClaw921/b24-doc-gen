# prisma.Webhook

Prisma-модель webhook-триггера для запуска генерации документов от Bitrix24 bizproc-робота «Исходящий вебхук».

## Поля
- id (cuid, pk)
- token (String unique) — URL-safe cryptorandom (base64url 24 bytes), публичная часть URL /api/webhook/run/:token.
- scope (String) — 'theme' | 'template'. Ровно одно из themeId/templateId должно быть установлено в соответствии со scope (invariant поддерживается роутом POST /api/webhooks).
- themeId (String?) → Theme, onDelete: Cascade. Когда scope='theme' — генерируются все Templates этой темы.
- templateId (String?) → Template, onDelete: Cascade. Когда scope='template' — генерируется только этот шаблон.
- label (String?) — человекочитаемая метка для UI.
- enabled (Bool @default(true)) — мягкое выключение без удаления.
- createdAt (DateTime)
- lastUsedAt (DateTime?) — обновляется исполнителем best-effort.
- useCount (Int @default(0)) — инкрементируется исполнителем best-effort.

## Индексы
- UNIQUE (token)
- INDEX (themeId)
- INDEX (templateId)

## Потребители
- routes/webhooks.ts — admin-only CRUD
- routes/webhookRun.ts — публичный исполнитель (лукап по token, enabled, scope→templateIds, update stats)

## Связи
- Theme.webhooks[] (back-relation)
- Template.webhooks[] (back-relation)

## Каскад при удалении
При удалении Theme или Template все связанные Webhook'и удаляются автоматически (onDelete: Cascade).
