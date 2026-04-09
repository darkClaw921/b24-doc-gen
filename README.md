<h1 align="center">📄 b24-doc-gen</h1>

<p align="center">
  <b>Локальное приложение для Bitrix24, которое превращает шаблон <code>.docx</code> в готовый документ сделки за один клик.</b>
</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node-20%2B-339933?logo=node.js&logoColor=white" alt="Node"></a>
  <a href="https://pnpm.io/"><img src="https://img.shields.io/badge/pnpm-9%2B-F69220?logo=pnpm&logoColor=white" alt="pnpm"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.4-3178C6?logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black" alt="React"></a>
  <a href="https://fastify.dev/"><img src="https://img.shields.io/badge/Fastify-4-000000?logo=fastify&logoColor=white" alt="Fastify"></a>
  <a href="https://www.prisma.io/"><img src="https://img.shields.io/badge/Prisma-SQLite-2D3748?logo=prisma&logoColor=white" alt="Prisma"></a>
  <a href="https://www.bitrix24.com/"><img src="https://img.shields.io/badge/Bitrix24-Local%20App-2FC6F6?logo=bitrix24" alt="Bitrix24"></a>
</p>

---

## ✨ Что это

`b24-doc-gen` встраивается прямо в карточку сделки Bitrix24 и решает одну
скучную, но болезненную задачу — **генерировать договоры, счета и акты
из заранее подготовленных `.docx`-шаблонов**.

| Кто | Что может |
|---|---|
| 👑 **Админ** | Загружать `.docx`-шаблоны, редактировать их в WYSIWYG, размечать поля и формулы поверх данных сделки/контакта/компании. |
| 👤 **Пользователь** | Открыть сделку, выбрать шаблон, увидеть preview с подставленными значениями, скачать `.docx` и автоматически прикрепить его к карточке. |

📐 Полная архитектура: [`architecture.md`](./architecture.md)

---

## 🎯 Почему именно так

- 🔒 **Self-hosted.** Данные сделок не покидают периметр компании.
- 🗄 **Своя SQLite-БД** для шаблонов и формул — без захламления Bitrix24 Disk, с гибким версионированием.
- 🧮 **Mini-DSL формул** поверх `mathjs`: `if`, `concat`, `format`, `dateFormat`, `upper`, `lower` — с автодополнением полей CRM.
- 🧩 **Точки интеграции** в Bitrix24:
  - `CRM_DEAL_DETAIL_TAB` — вкладка **«Документы»** в карточке сделки (для всех);
  - `DEFAULT` — пункт меню **«Шаблоны документов»** (для админов).
- ⚡️ **Webhook-триггеры** — генерация документа по событию, без ручного клика.

---

## 📦 Стек

<table>
<tr>
<td><b>Frontend</b></td>
<td>React 18 · Vite · TanStack Query · Zustand · Tailwind · shadcn/ui · TipTap (WYSIWYG) · @bitrix24/b24jssdk</td>
</tr>
<tr>
<td><b>Backend</b></td>
<td>Fastify 4 · Prisma · SQLite · mammoth (.docx → HTML) · docx (HTML → .docx) · mathjs</td>
</tr>
<tr>
<td><b>Shared</b></td>
<td>pnpm workspaces · TypeScript strict · общие типы в <code>@b24-doc-gen/shared</code></td>
</tr>
</table>

---

## 🚀 Быстрый старт

### Требования

- Node.js **20+**
- pnpm **9+**
- Bitrix24-портал с правами администратора (для регистрации локального приложения)
- HTTPS-туннель для фронта (`ngrok`, `cloudflared` и т.п.) — Bitrix24 не открывает HTTP-iframes

### Установка и запуск

```bash
# 1. Установить зависимости
pnpm install

# 2. Сконфигурировать переменные окружения
cp .env.example apps/backend/.env
# отредактировать apps/backend/.env: B24_APP_ID, B24_APP_SECRET, PUBLIC_URL

# 3. Применить Prisma-миграции (создаст apps/backend/prisma/dev.db)
pnpm -F backend db:push

# 4. Запустить frontend + backend параллельно
pnpm dev
```

После запуска:

| Сервис | URL |
|---|---|
| 🎨 Frontend (Vite) | http://localhost:5173 |
| ⚙️ Backend (Fastify) | http://localhost:3001 |
| ❤️ Healthcheck | http://localhost:3001/health |

---

## 🛠 Полезные скрипты

### pnpm-команды

| Команда | Что делает |
|---|---|
| `pnpm dev` | Запустить frontend и backend параллельно (обёртка над `scripts/dev.sh`) |
| `pnpm dev:frontend` | Только Vite dev-server |
| `pnpm dev:backend` | Только Fastify (`tsx watch`) |
| `pnpm build` | Сборка всех пакетов (`pnpm -r build`) |
| `pnpm prod` | Полный prod-цикл — сборка и запуск (`scripts/prod.sh`) |
| `pnpm prod:build` | Только сборка для prod (`scripts/prod.sh --build-only`) |
| `pnpm prod:start` | Запуск prod без пересборки (`scripts/prod.sh --skip-build`) |
| `pnpm typecheck` | `tsc --noEmit` по всем пакетам |
| `pnpm lint` | Линтер |
| `pnpm clean` | Очистка `dist` и `node_modules` |
| `pnpm -F backend db:push` | Синхронизация Prisma-схемы с SQLite |
| `pnpm -F backend db:migrate` | Создание и применение миграции |
| `pnpm -F backend db:generate` | Перегенерировать Prisma Client |

### Bash-скрипты в `scripts/`

Большая часть `pnpm`-команд — тонкие обёртки над bash-скриптами в каталоге [`scripts/`](./scripts). Их можно вызывать и напрямую.

#### 🧪 [`scripts/dev.sh`](./scripts/dev.sh) — dev-окружение

Запускает backend и frontend параллельно с hot-reload. Скрипт умеет авто-настраивать машину «с нуля» на Ubuntu/Debian:

- 🔍 проверяет наличие **Node.js 20+** и при отсутствии ставит его через NodeSource;
- 📦 проверяет наличие **pnpm 9+** (`corepack enable` или `npm i -g pnpm`);
- 📥 ставит зависимости (`pnpm install`) при пустом `node_modules`;
- 🗄 применяет Prisma-миграции (`db:push`) при отсутствии `dev.db`;
- 🎨 цветной лог через `[dev]`-префиксы (`info` / `success` / `warn` / `error`).

```bash
bash scripts/dev.sh
# или короче:
pnpm dev
```

#### 🚀 [`scripts/prod.sh`](./scripts/prod.sh) — production-сборка и запуск

Собирает оба пакета (`apps/backend` → `dist/`, `apps/frontend` → статика Vite) и запускает Node.js-сервер. Поддерживает флаги:

| Флаг | Что делает |
|---|---|
| *(без флагов)* | Полный цикл: install → build → migrate → start |
| `--build-only` | Только сборка, без запуска (CI/CD) |
| `--skip-build` | Запуск из уже собранного `dist/`, без пересборки |
| `--help`, `-h` | Подсказка по флагам |

```bash
bash scripts/prod.sh                # полный цикл
bash scripts/prod.sh --build-only   # только сборка
bash scripts/prod.sh --skip-build   # быстрый рестарт

# те же действия через pnpm:
pnpm prod
pnpm prod:build
pnpm prod:start
```

> 💡 В prod-режиме backend Fastify сам отдаёт собранную фронтовую статику и проксирует `/api/*`, поэтому **публикуется один-единственный порт** (`BACKEND_PORT`) — именно его нужно пробрасывать через ngrok / cloudflared / nginx.

---

## 🔌 Регистрация в Bitrix24

1. Откройте портал → **Приложения → Разработчикам → Другое → Локальное приложение**.
2. Заполните форму:

   | Поле | Значение |
   |---|---|
   | Тип использования | **Серверное** |
   | URL обработчика | `https://<ваш-public-url>/` |
   | URL установки | `https://<ваш-public-url>/?view=install` |
   | Назначение | placement-ы регистрируются автоматически после установки |

3. Поставьте scope:

   - `crm` — поля сделки/контакта/компании, обновление сделки, `crm.timeline.comment.add`
   - `user` — поиск пользователей в InstallPage и SettingsPage
   - `disk` — загрузка `.docx` через `disk.folder.uploadfile`
   - `placement` — `placement.bind` для авторегистрации placement-ов

4. Сохраните — Bitrix24 выдаст:

   | Поле | Куда положить |
   |---|---|
   | **APP ID** | `B24_APP_ID` |
   | **APP SECRET** | `B24_APP_SECRET` |
   | **Домен портала** | используется в auth-проверках |

> ⚠️ Frontend должен быть доступен по **HTTPS** — Bitrix24 заблокирует HTTP-iframe (за исключением `127.0.0.1` для разработки).

---

## 🧰 Установка приложения на портал

1. На странице локального приложения нажмите **«Установить»** — Bitrix24 откроет `https://<frontend>/?view=install`.
2. Frontend получит auth-payload через `@bitrix24/b24jssdk`, отправит `POST /api/install`, затем `POST /api/install/register-placements` — placement-ы зарегистрируются автоматически.
3. После установки приложение появится:
   - 📁 в карточке любой сделки во вкладке **«Документы»**;
   - 📚 в общем меню Bitrix24 как **«Шаблоны документов»** (только для админов).

---

## ⚙️ Первая настройка (`/settings`)

1. **Поле для сгенерированных файлов.** Выберите существующее `UF_CRM_*`-поле сделки типа `file`. Если такого нет — нажмите «Создать поле», задайте XML_ID (например `DOC_FILES`) и подпись; backend вызовет `crm.deal.userfield.add` за вас.
2. **Администраторы.** В этом же экране через debounced-поиск можно добавлять/удалять админов. Mutation-роуты (POST/PUT/DELETE на темы, шаблоны, настройки) разрешены **только** пользователям из этого списка.
3. Нажмите **«Сохранить»** — настройки уйдут в `PUT /api/settings`, серверный кеш ролей сбросится автоматически.

---

## 📝 Использование

### 👑 Админ — управление шаблонами

1. Откройте Bitrix24 → пункт меню **«Шаблоны документов»**.
2. Слева создайте тему (например, *«Договоры»*).
3. Нажмите **«Загрузить шаблон»** → выберите `.docx` → файл будет сконвертирован в HTML mammoth-ом и открыт в TipTap-редакторе.
4. Кнопкой **Σ** в тулбаре откройте `<FormulaBuilder>`, выберите поля из вкладок *Сделка / Контакт / Компания*, напишите выражение:

   ```
   OPPORTUNITY * 0.2
   concat(LAST_NAME, " ", NAME)
   format(OPPORTUNITY, "money")
   if(STAGE_ID == "WON", "Оплачено", "В работе")
   ```

   Нажмите **«Вставить»** — в редакторе появится pill `Σ Label`.
5. Сохраните шаблон.

### 👤 Пользователь — генерация документа

1. Откройте сделку → вкладка **«Документы»**.
2. Слева — список тем и шаблонов. Выберите шаблон.
3. В центре загрузится **preview** с подставленными значениями (`GET /api/templates/:id/preview?dealId=`).
4. Справа нажмите **«Сгенерировать документ»** — backend пройдёт по конвейеру:

   ```
   dealData → formulaEngine → docxBuilder → uploadDiskFile
            → crm.deal.update → crm.timeline.comment.add
   ```

   и вернёт `{fileId, downloadUrl, ...}`. Файл автоматически появится в выбранном `UF_CRM`-поле сделки и в таймлайне.

---

## 🌱 Переменные окружения

Полный список — в [`.env.example`](./.env.example). Минимально необходимое:

| Переменная | Назначение |
|---|---|
| `B24_APP_ID` | ID локального приложения (выдан Bitrix24) |
| `B24_APP_SECRET` | Секрет приложения (HMAC-проверка auth) |
| `DATABASE_URL` | Путь к SQLite (`file:./dev.db`) |
| `BACKEND_PORT` | Порт Fastify (по умолчанию `3001`) |
| `BACKEND_HOST` | Хост Fastify (по умолчанию `0.0.0.0`) |
| `PUBLIC_URL` | Публичный HTTPS-URL (ngrok/cloudflared) — на него Bitrix24 шлёт iframe |
| `FRONTEND_URL` | URL Vite для CORS в dev-режиме |
| `NODE_ENV` | `development` / `production` |
| `LOG_LEVEL` | Уровень логов pino |

---

## 🗂 Структура проекта

```
b24-doc-gen/
├── apps/
│   ├── frontend/                  # Vite + React 18 SPA
│   │   ├── src/
│   │   │   ├── pages/             # Install / Templates / Editor / Generate / Settings
│   │   │   ├── components/        # PlacementGuard, AdminOnly, ThemeSidebar,
│   │   │   │                      #   TemplateUploader, FormulaBuilder, Editor/
│   │   │   ├── components/ui/     # shadcn/ui + Toaster
│   │   │   └── lib/               # api.ts, b24.ts, formulas.ts,
│   │   │                          #   useCurrentRole.ts, useApiError.ts
│   │   └── vite.config.ts
│   └── backend/                   # Fastify REST API + Prisma + SQLite
│       ├── src/
│       │   ├── server.ts          # buildServer() + central error handler
│       │   ├── routes/            # health, install, me, deal, users,
│       │   │                      #   themes, templates, formulas,
│       │   │                      #   settings, generate, webhooks
│       │   ├── middleware/        # auth.ts, role.ts (requireAdmin)
│       │   ├── services/          # b24Client, dealData, docxParser,
│       │   │                      #   docxBuilder, formulaEngine, cache
│       │   └── prisma/client.ts
│       └── prisma/
│           ├── schema.prisma      # AppSettings · Theme · Template · Formula · Webhook
│           └── migrations/
├── packages/
│   └── shared/                    # @b24-doc-gen/shared (TS-типы)
├── architecture.md                # Подробная архитектура
├── README.md                      # Этот файл
├── package.json                   # pnpm workspace root
├── pnpm-workspace.yaml
└── .env.example
```

---

## 🧪 Проверка backend

```bash
curl http://localhost:3001/health
# → {"status":"ok","service":"b24-doc-gen-backend", ...}
```

---

## 📄 Лицензия

Внутреннее приложение. Лицензия — по согласованию с правообладателем.

<div align="center">

Сделано с ❤️ для тех, кто устал копировать договоры вручную.

</div>
