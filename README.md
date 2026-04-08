# b24-doc-gen

Локальное (self-hosted) приложение для Bitrix24, которое встраивается
в карточку сделки и позволяет:

- **админам** — загружать `.docx`-шаблоны, редактировать их в WYSIWYG,
  вставлять формулы по полям сделки, контакта и компании;
- **обычным пользователям** — выбирать готовый шаблон, видеть preview
  с подставленными значениями, генерировать `.docx`-файл и автоматически
  привязывать его к сделке (поле UF_CRM_* типа `file` + комментарий
  в таймлайн).

Подробная архитектура: [`architecture.md`](./architecture.md).

## 1. Описание приложения

`b24-doc-gen` решает одну задачу — генерировать договоры/счета/акты на
основе данных сделки. От других решений отличается тем, что:

- работает локально на вашем сервере (исходные данные не покидают
  периметр компании);
- хранит шаблоны и формулы в собственной SQLite-БД, а не в Bitrix24
  Disk — это даёт гибкое версионирование;
- позволяет писать формулы на mini-DSL поверх `mathjs` (`if`, `concat`,
  `format`, `dateFormat`, `upper`, `lower`) с автодополнением полей.

Точка интеграции в Bitrix24:

- `CRM_DEAL_DETAIL_TAB` — вкладка «Документы» в карточке сделки
  (для всех пользователей).
- `DEFAULT` — общий пункт меню «Шаблоны документов» (для админов).

## 2. Требования

- Node.js **20+**
- pnpm **9+**
- Bitrix24 portal с правом администратора (нужно один раз для
  регистрации локального приложения)
- Любая публично доступная HTTPS-точка для frontend (Bitrix24 не
  открывает HTTP-iframes); во время разработки можно использовать
  `ngrok` или `cloudflared`.

## 3. Локальная разработка

```bash
# 1) Установить зависимости для всех пакетов
pnpm install

# 2) Сконфигурировать переменные окружения
cp .env.example apps/backend/.env
# отредактировать apps/backend/.env (минимум: B24_APP_ID, B24_APP_SECRET,
# B24_ALLOWED_DOMAINS, FRONTEND_PUBLIC_URL)

# 3) Применить миграции Prisma (создаст apps/backend/prisma/dev.db)
pnpm -F backend db:push
# Либо полноценная миграция:
pnpm -F backend db:migrate

# 4) Запустить frontend и backend параллельно
pnpm dev
# frontend: http://localhost:5173
# backend:  http://localhost:3001

# Отдельно:
pnpm dev:frontend
pnpm dev:backend
```

Проверка backend:

```bash
curl http://localhost:3001/health
# → {"status":"ok","service":"b24-doc-gen-backend", ...}
```

Полезные скрипты:

| Команда | Назначение |
|---|---|
| `pnpm dev` | Запустить frontend + backend параллельно |
| `pnpm dev:frontend` | Только Vite dev-server |
| `pnpm dev:backend` | Только Fastify (`tsx watch`) |
| `pnpm build` | Сборка всех пакетов (`pnpm -r build`) |
| `pnpm typecheck` | `tsc --noEmit` по всем пакетам |
| `pnpm lint` | Линтер |
| `pnpm -F backend db:push` | Синхронизация Prisma-схемы с SQLite |
| `pnpm -F backend db:migrate` | Создание и применение миграции |
| `pnpm -F backend db:generate` | Перегенерировать Prisma Client |

## 4. Регистрация локального приложения в Bitrix24

1. Откройте портал → «Приложения» → «Разработчикам» → «Другое» →
   «Локальное приложение».
2. Заполните поля:

   | Поле | Значение |
   |---|---|
   | Тип использования | **Серверное** (server-side) |
   | URL вашего обработчика | `https://<ваш-frontend-url>/` |
   | URL первоначальной установки | `https://<ваш-frontend-url>/?view=install` |
   | Назначение приложения | поставить ВСЕ нужные **placement-ы** (см. ниже) |

3. Поставьте необходимые scope:

   - `crm` — чтение полей сделки/контакта/компании, обновление сделки,
     `crm.timeline.comment.add`
   - `user` — поиск пользователей в InstallPage и SettingsPage
   - `disk` — загрузка сгенерированных `.docx` через `disk.folder.uploadfile`
   - `placement` — `placement.bind` для регистрации placement-ов из
     самого приложения

4. Сохраните приложение. Bitrix24 покажет:

   - **APP ID** (`local.xxxxxxxxxxxxxxxxxxxxx`) — положите в
     `B24_APP_ID`
   - **APP SECRET** — положите в `B24_APP_SECRET`
   - **Домен портала** (например, `mycompany.bitrix24.ru`) —
     добавьте в `B24_ALLOWED_DOMAINS`

5. Не забудьте, что фронтенд должен быть **доступен по HTTPS** —
   Bitrix24 заблокирует iframe с http:// (кроме localhost для разработки
   через `127.0.0.1`).

## 5. Установка приложения на портал

1. После сохранения локального приложения на портале нажмите
   «Установить» — Bitrix24 откроет ваш `URL первоначальной установки`
   (`https://<frontend-url>/?view=install`) во вкладке.
2. Frontend получит auth-payload через `@bitrix24/b24jssdk`,
   автоматически отправит `POST /api/install` (после того, как админ
   выберет себя в списке), а затем `POST /api/install/register-placements`
   — это автоматически зарегистрирует placement-ы `CRM_DEAL_DETAIL_TAB`
   и `DEFAULT`.
3. После успешной установки приложение появится:
   - в карточке любой сделки во вкладке **«Документы»**;
   - в общем меню Bitrix24 как **«Шаблоны документов»** (только для
     админов).

## 6. Первая настройка

После установки админ должен один раз пройти страницу `/settings`:

1. **Поле для сгенерированных файлов.** Выберите существующее
   `UF_CRM_*` поле сделки типа `file`, куда будут попадать
   сгенерированные `.docx`. Если такого поля нет — нажмите «Создать
   поле», задайте XML_ID (например `DOC_FILES`) и подпись. Backend
   вызовет `crm.deal.userfield.add` за вас.
2. **Администраторы.** В этом же экране через debounced-поиск можно
   добавлять/удалять администраторов. Все mutation-роуты
   (POST/PUT/DELETE на темы и шаблоны, PUT настроек) будут разрешены
   только пользователям из этого списка.
3. Нажмите **«Сохранить»** — настройки уйдут в `PUT /api/settings`,
   серверный кеш ролей сбросится автоматически.

## 7. Использование

### Админ — управление шаблонами

- Откройте Bitrix24 → пункт меню «Шаблоны документов».
- Слева создайте тему (например «Договоры»). Только админ видит
  кнопки `+` и DropdownMenu действий.
- Нажмите «Загрузить шаблон» → выберите `.docx` → файл будет
  сконвертирован в HTML mammoth-ом и открыт в TipTap-редакторе.
- Кнопкой Σ в тулбаре откройте `<FormulaBuilder>`, выберите поля из
  трёх вкладок (Сделка/Контакт/Компания), напишите выражение
  (`OPPORTUNITY * 0.2`, `concat(LAST_NAME, " ", NAME)`,
  `format(OPPORTUNITY, "money")` и т. д.), нажмите «Вставить» — в
  редакторе появится pill `Σ Label`.
- Сохраните шаблон.

### Пользователь — генерация документа

- Откройте любую сделку → вкладка «Документы».
- Слева — список тем и шаблонов. Выберите шаблон.
- В центре загрузится preview с подставленными значениями формул
  (через `GET /api/templates/:id/preview?dealId=`).
- Справа нажмите «Сгенерировать документ» — backend пройдёт по
  конвейеру `dealData → formulaEngine → docxBuilder → uploadDiskFile
  → crm.deal.update → crm.timeline.comment.add` и вернёт
  `{fileId, downloadUrl, ...}`. Файл автоматически появится в карточке
  сделки в выбранном UF_CRM-поле и в таймлайне.

## 8. Переменные окружения

Полный список — в [`.env.example`](./.env.example). Минимально
необходимый набор для production:

| Переменная | Назначение |
|---|---|
| `B24_APP_ID` | ID локального приложения (выдан Bitrix24) |
| `B24_APP_SECRET` | Секрет приложения (для HMAC-проверки auth) |
| `B24_ALLOWED_DOMAINS` | CSV доменов портала, например `mycompany.bitrix24.ru` |
| `DATABASE_URL` | Путь к SQLite (`file:./dev.db`) |
| `BACKEND_PORT` | Порт Fastify (по умолчанию `3001`) |
| `BACKEND_HOST` | Хост Fastify (по умолчанию `0.0.0.0`) |
| `FRONTEND_URL` | URL фронтенда для CORS (`http://localhost:5173` в dev) |
| `FRONTEND_PUBLIC_URL` | Публичный HTTPS-URL фронтенда — используется в `placement.bind` как handler |
| `NODE_ENV` | `development` / `production` |
| `LOG_LEVEL` | Уровень логов pino (`info`, `debug`, …) |

## 9. Структура проекта

```
b24-doc-gen/
├── apps/
│   ├── frontend/                  # Vite + React 18 SPA
│   │   ├── src/
│   │   │   ├── pages/             # InstallPage, TemplatesPage,
│   │   │   │                      #   TemplateEditorPage, GeneratePage,
│   │   │   │                      #   SettingsPage
│   │   │   ├── components/        # PlacementGuard, AdminOnly,
│   │   │   │                      #   ThemeSidebar, TemplateUploader,
│   │   │   │                      #   FormulaBuilder, FieldPicker,
│   │   │   │                      #   FormulaTag, Editor/
│   │   │   ├── components/ui/     # shadcn/ui + Toaster
│   │   │   └── lib/               # api.ts, b24.ts, formulas.ts,
│   │   │                          #   useCurrentRole.ts, useApiError.ts
│   │   └── vite.config.ts
│   └── backend/                   # Fastify REST API + Prisma + SQLite
│       ├── src/
│       │   ├── server.ts          # buildServer() + central error handler
│       │   ├── routes/            # health, install, me, deal, users,
│       │   │                      #   themes, templates, formulas,
│       │   │                      #   settings, generate
│       │   ├── middleware/        # auth.ts, role.ts (requireAdmin)
│       │   ├── services/          # b24Client, dealData, docxParser,
│       │   │                      #   docxBuilder, formulaEngine, cache
│       │   └── prisma/client.ts
│       └── prisma/
│           ├── schema.prisma      # AppSettings, Theme, Template, Formula
│           └── migrations/
├── packages/
│   └── shared/                    # @b24-doc-gen/shared (TS-типы)
├── architecture.md                # Подробная архитектура
├── README.md                      # Этот файл
├── package.json                   # pnpm workspace root
├── pnpm-workspace.yaml
└── .env.example
```

## Лицензия

Внутреннее приложение, лицензия по согласованию с правообладателем.
