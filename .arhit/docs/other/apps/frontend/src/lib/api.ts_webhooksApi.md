# apps/frontend/src/lib/api.ts#webhooksApi

Клиентский API-клиент для admin-only CRUD webhook'ов. Группа методов в объекте webhooksApi в lib/api.ts.

## Методы
- list(): Promise<{webhooks: WebhookListItemDTO[]}> — GET /api/webhooks. DTO расширяет WebhookSummary из @b24-doc-gen/shared полями themeName/templateName (join-данные для UI без доп. round-trip).
- create(body: CreateWebhookBody): Promise<{webhook: WebhookSummary}> — POST /api/webhooks. Body: {scope: 'theme'|'template', themeId?, templateId?, label?}.
- patch(id, body: UpdateWebhookBody): Promise<{webhook: WebhookSummary}> — PATCH /api/webhooks/:id. Body: {label?, enabled?}.
- remove(id): Promise<void> — DELETE /api/webhooks/:id.

## Типы
- WebhookListItemDTO = WebhookSummary & {themeName: string|null; templateName: string|null}
- CreateWebhookBody, UpdateWebhookBody — локальные типы в lib/api.ts

## Зависимости
- apiRequest<T>() — низкоуровневый fetch wrapper с X-B24-* заголовками
- @b24-doc-gen/shared → WebhookSummary

## Потребители
- components/WebhookManagerDialog.tsx (все 4 метода через TanStack Query mutations)
