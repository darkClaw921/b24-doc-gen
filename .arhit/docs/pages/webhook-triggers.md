# Webhook-триггеры для генерации документов

Фича позволяет запускать pipeline генерации документов автоматически, без кликов в UI, через Bitrix24 bizproc-робот «Исходящий вебхук» (CRM → Автоматизация → Роботы).

## Компоненты

### Данные
- **prisma.Webhook** — модель триггера (token, scope, themeId|templateId, enabled, useCount, lastUsedAt).
- **AppSettings.applicationToken** — shared secret портала для аутентификации входящих вызовов (сохраняется при установке приложения).

### Backend
- **routes/webhooks.ts** — admin-only CRUD (GET/POST/PATCH/DELETE /api/webhooks). Генерирует token через crypto.randomBytes(24).base64url. Гейтится requireAdmin.
- **routes/webhookRun.ts** — публичный POST /api/webhook/run/:token. Парсит Bitrix form-urlencoded payload через qs (auth[application_token], document_id[0..2]), валидирует, вызывает runGeneration() последовательно для каждого шаблона в scope, обновляет stats, опционально ack'ает через bizproc.event.send.
- **middleware/auth.ts → PUBLIC_PATHS** — добавлен '/api/webhook/run' чтобы публичный endpoint не проходил B24 middleware.
- **services/generationPipeline.ts → runGeneration()** — переиспользуемое ядро генерации, одно и то же для UI и webhook'а.

### Frontend
- **lib/api.ts → webhooksApi** — клиентские методы list/create/patch/remove.
- **components/WebhookManagerDialog.tsx** — модал управления: список, создать, копировать URL (с fallback для iframe), toggle enabled, удалить.
- **components/ThemeSidebar.tsx** — пункт DropdownMenu «Webhook темы» (admin-only) → открывает диалог со scope='theme'.
- **pages/TemplatesPage.tsx** — кнопка «Webhook» на карточке шаблона (admin-only) → открывает диалог со scope='template'.

## Поток исполнения (runtime)

1. Админ открывает Theme или Template в UI → WebhookManagerDialog → создаёт webhook → копирует URL.
2. Админ вставляет URL в робот Bitrix «Исходящий вебхук», метод POST, на нужную стадию сделки.
3. Сделка переходит в стадию → Bitrix POST'ит на /api/webhook/run/:token с payload auth[application_token]/auth[access_token]/auth[domain]/document_id[0..2]/event_token.
4. backend валидирует → парсит DEAL_<id> → new B24Client → resolve templateIds → runGeneration() sequential → stats update → optional ack → JSON response.

## Модель угроз и защита
- Token в URL — единственный идентификатор webhook'а. 24 bytes base64url (192 bits) — enumeration-атаки невозможны.
- application_token — shared secret. Гарантирует, что вызов пришёл от нашего портала, а не от атакующего с утечённым token.
- enabled=false — возвращает 404 (не 403), чтобы не раскрывать существование webhook'а.
- per-template try/catch — один битый шаблон не ломает остальные в scope.

## Негативные кейсы (проверено)
- 404 nonexistent / disabled
- 401 bad / missing application_token / AppSettings.applicationToken не настроен
- 400 malformed document_id / missing auth.domain/access_token
- 0 ERROR-level логов на клиентских ошибках (только warn/info)

## Ссылки на документацию элементов
- arhit doc show apps/backend/src/routes/webhooks.ts
- arhit doc show apps/backend/src/routes/webhookRun.ts
- arhit doc show prisma.Webhook
- arhit doc show apps/frontend/src/components/WebhookManagerDialog.tsx
- arhit doc show 'apps/frontend/src/lib/api.ts#webhooksApi'