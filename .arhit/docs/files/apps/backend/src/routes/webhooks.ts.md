# apps/backend/src/routes/webhooks.ts

Admin-only CRUD endpoint для webhook-триггеров Bitrix24-робота «Исходящий вебхук».

## Назначение
Позволяет админам создавать, просматривать, обновлять и удалять URL-тогглы, которые Bitrix24 bizproc-робот «Исходящий вебхук» POST'ит для запуска генерации документов без участия пользователя. Каждый webhook привязан к одной Theme (scope='theme' — сгенерировать все Templates темы) или к одному Template (scope='template' — сгенерировать один шаблон).

## Маршруты
- GET /api/webhooks — список всех webhook'ов с join'ом Theme/Template (themeName/templateName) для UI, сортировка по createdAt desc.
- POST /api/webhooks — создать. Body: {scope: 'theme'|'template', themeId?, templateId?, label?}. Генерирует token = randomBytes(24).toString('base64url'). Валидирует существование Theme/Template. Retry x3 на P2002 (unique token collision). Возвращает 201 + WebhookSummary.
- PATCH /api/webhooks/:id — обновление только label и enabled (прочие поля immutable). Возвращает 400 если body пустой.
- DELETE /api/webhooks/:id — 204. P2025 → 404.

## Гейтинг
Все роуты оборачиваются в preHandler: requireAdmin из middleware/role.ts. Не-админ получает 403.

## Хелперы
- resolvePublicBaseUrl(): читает PUBLIC_URL/FRONTEND_PUBLIC_URL/FRONTEND_URL (аналогично routes/install.ts), подрезает trailing slash.
- buildWebhookUrl(token): собирает '{base}/api/webhook/run/{token}'.
- toWebhookSummary(row): Prisma row → WebhookSummary DTO из @b24-doc-gen/shared.
- normalizeLabel(value): string|null, max 200 chars, пустая → null, undefined сохраняется.
- normalizeScope(value): 'theme'|'template'|null.
- generateToken(): randomBytes(24).toString('base64url').

## Зависимости
- prisma.webhook (модель Webhook из schema.prisma)
- prisma.theme / prisma.template (валидация FK)
- middleware/role.ts → requireAdmin
- @b24-doc-gen/shared → WebhookSummary

## Примеры
POST /api/webhooks
  {"scope":"template","templateId":"cuid_abc","label":"Smart invoice trigger"}
→ 201 {webhook: {id, token, url: 'https://.../api/webhook/run/<token>', scope:'template', templateId, label, enabled:true, useCount:0, ...}}
