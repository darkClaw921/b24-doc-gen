# Архитектура b24-doc-gen

Документ описывает структуру проекта — монорепо, модули, файлы и их
назначение. Обновляется при каждом добавлении/удалении файла, функции
или класса.

## Обзор

`b24-doc-gen` — локальное приложение для Bitrix24, которое встраивается
в карточку сделки через `PLACEMENT_BIND` и позволяет:

- **Админам** загружать .docx-шаблоны, редактировать их в WYSIWYG,
  вставлять формулы на основе полей сделки/контакта/компании.
- **Пользователям** выбирать шаблон, видеть preview с подставленными
  значениями, генерировать .docx и привязывать его к сделке.

Архитектурно проект — это pnpm monorepo с тремя пакетами:

- [`apps/frontend`](./apps/frontend) — React SPA (Vite)
- [`apps/backend`](./apps/backend) — Fastify REST API + Prisma/SQLite
- [`packages/shared`](./packages/shared) — общие TypeScript-типы

## Корневые файлы

| Файл | Назначение |
|---|---|
| [`package.json`](./package.json) | pnpm workspace root. Общие скрипты (`dev`, `build`, `typecheck`), devDependencies (TypeScript, Prettier). |
| [`pnpm-workspace.yaml`](./pnpm-workspace.yaml) | Декларация workspace: `apps/*`, `packages/*`. |
| [`tsconfig.base.json`](./tsconfig.base.json) | Базовый TS-конфиг, который наследуют `apps/frontend`, `apps/backend`, `packages/shared`. Target ES2022, strict: true, ESM. |
| [`.gitignore`](./.gitignore) | Игнор `node_modules`, `dist`, `.env`, `*.db`. |
| [`.npmrc`](./.npmrc) | Настройки pnpm: `auto-install-peers=true`. |
| [`.prettierrc.json`](./.prettierrc.json) | Конфиг Prettier (single quotes, trailing commas). |
| [`.env.example`](./.env.example) | Пример переменных окружения (B24_APP_ID/SECRET, DATABASE_URL, порты). |
| [`README.md`](./README.md) | Инструкция по установке и запуску. |
| [`architecture.md`](./architecture.md) | Текущий документ. |

## Пакеты

### packages/shared

Общие TypeScript-типы. Импортируется фронтендом и бэкендом через
workspace-зависимость `@b24-doc-gen/shared`. Не содержит runtime-кода —
только типы.

| Файл | Назначение |
|---|---|
| [`packages/shared/package.json`](./packages/shared/package.json) | Манифест `@b24-doc-gen/shared`. `main`/`types` указывают на `src/index.ts` (ESM re-export). |
| [`packages/shared/tsconfig.json`](./packages/shared/tsconfig.json) | TS-конфиг с `composite: true` (для project references). |
| [`packages/shared/src/index.ts`](./packages/shared/src/index.ts) | Точка входа, реэкспортирует всё из `types.ts`. |
| [`packages/shared/src/types.ts`](./packages/shared/src/types.ts) | Все интерфейсы: `AppSettings`, `Theme`, `Template`, `Formula`, `FormulaDependencies`, `DealField`, `EntityValues`, `FormulaContext`, `FormulaEvaluationResult`, `B24AuthPayload`, `InstallRequest/Response`, `TemplatePreviewResponse`, `GenerateRequest/Response`, `ApiError` (legacy flat shape), `ApiErrorBody`/`ApiErrorEnvelope` (Фаза 6 — wrapped envelope от центрального error handler), `AppRole`. |

### apps/frontend

React 18 SPA, встраивается в iframe Bitrix24. Собирается Vite.

| Файл | Назначение |
|---|---|
| [`apps/frontend/package.json`](./apps/frontend/package.json) | Манифест. Зависимости: `react`, `react-dom`, `react-router-dom`, `zustand`, `@tanstack/react-query`, `@radix-ui/*`, `lucide-react`, `class-variance-authority`, `clsx`, `tailwind-merge`, `tailwindcss-animate`, `@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit`, `@tiptap/extension-image`, `@tiptap/extension-table` (вместе с TableRow/TableHeader/TableCell), `react-dropzone`, `@b24-doc-gen/shared` (workspace:*). |
| [`apps/frontend/tsconfig.json`](./apps/frontend/tsconfig.json) | TS-конфиг (JSX react-jsx, path alias `@/*`, reference на `packages/shared`). |
| [`apps/frontend/vite.config.ts`](./apps/frontend/vite.config.ts) | Vite-конфиг: порт 5173, proxy `/api` → `http://localhost:3001`, alias `@` → `src`. |
| [`apps/frontend/tailwind.config.ts`](./apps/frontend/tailwind.config.ts) | Tailwind-конфиг с темой shadcn/ui (HSL-переменные, анимации). |
| [`apps/frontend/postcss.config.cjs`](./apps/frontend/postcss.config.cjs) | PostCSS-конфиг (tailwindcss + autoprefixer). |
| [`apps/frontend/components.json`](./apps/frontend/components.json) | Конфиг shadcn/ui CLI. |
| [`apps/frontend/index.html`](./apps/frontend/index.html) | HTML-шаблон для Vite. |

#### apps/frontend/src

| Файл | Назначение |
|---|---|
| [`apps/frontend/src/main.tsx`](./apps/frontend/src/main.tsx) | Точка входа. Создаёт QueryClient, оборачивает `<App>` в `BrowserRouter` + `QueryClientProvider`. |
| [`apps/frontend/src/App.tsx`](./apps/frontend/src/App.tsx) | Корневой компонент с маршрутами: `/install`, `/templates`, `/templates/:id/edit`, `/generate`, `/settings`. Оборачивает дерево в `<PlacementGuard>` и монтирует глобальный `<Toaster>` (Фаза 6). |
| [`apps/frontend/src/index.css`](./apps/frontend/src/index.css) | Директивы Tailwind + CSS-переменные shadcn/ui (light/dark). |
| [`apps/frontend/src/vite-env.d.ts`](./apps/frontend/src/vite-env.d.ts) | Декларации Vite client-типов. |
| [`apps/frontend/src/lib/utils.ts`](./apps/frontend/src/lib/utils.ts) | Утилита `cn(...)` — объединение классов через `clsx` + `tailwind-merge`. |
| [`apps/frontend/src/lib/b24.ts`](./apps/frontend/src/lib/b24.ts) | Bootstrap Bitrix24 SDK. Экспортирует `initB24`, `getB24`, `getB24Auth`, `refreshB24Auth`, `getCurrentUserId`, `getCurrentDealId`, `getCurrentPlacement`, `getPlacementOptions`, `getB24AuthHeaders`, `isB24Available`, `getB24InitError`. Кеширует `B24Frame` в module-scope, поддерживает запуск вне iframe. |
| [`apps/frontend/src/lib/api.ts`](./apps/frontend/src/lib/api.ts) | Fetch-клиент бэкенда. `apiRequest<T>()` добавляет `X-B24-*` заголовки из SDK. `uploadRequest<T>()` — XHR-upload с прогрессом для multipart запросов. Группы: `installApi` (`status`, `install`, `registerPlacements`), `meApi` (`get` — GET /api/me, Фаза 6), `usersApi` (`search`), `dealApi` (`fields`, `data`), `crmApi` (`allFields` — объединённый GET /api/crm/fields для трёх сущностей), `themesApi` (`list`/`create`/`update`/`delete`), `templatesApi` (`list`/`get`/`preview`/`create`/`update`/`delete`/`upload`), `formulasApi` (`validate`, `evaluate`), `generateApi` (`generate` POST /api/generate), `settingsApi` (`get`, `update`, `dealFields`, `createField`). DTO: `TemplatePreviewResponseDTO`, `GenerateResponseDTO`, `SettingsDTO`, `DealFileFieldDTO`, `FormulaEvaluationResultDTO`, `MeDTO`, `AppRoleDTO`. Класс `ApiError` (с полем `code`); функции `extractApiMessage(payload, fallback)` и `extractApiCode(payload)` нормализуют как новый envelope `{error:{code,message,details}}` (Фаза 6 централизованный handler), так и legacy flat shape от fastify-sensible. |
| [`apps/frontend/src/lib/formulas.ts`](./apps/frontend/src/lib/formulas.ts) | Клиентские хелперы для формул (Фаза 4). `validateLocally(expression)` — синхронная проверка пустоты/длины/сбалансированности скобок и строковых литералов. `validateRemote(expression)` — обёртка над `POST /api/formulas/validate`, нормализующая ответ в `LocalValidationResult` (valid, error?, dependencies?). `generateTagKey(label, existing)` — slugify с транслитерацией кириллицы и разрешением коллизий через суффиксы `_2`, `_3`. |
| [`apps/frontend/src/lib/formulaHelp.ts`](./apps/frontend/src/lib/formulaHelp.ts) | Справочник метаданных функций и операторов формул. Экспортирует `HELPER_DOCS` (Record по имени функции: `signature`, `summary`, `description`, `args[]`, `examples[]`) для `if`/`concat`/`format`/`dateFormat`/`upper`/`lower` и `OPERATOR_DOCS` (символ → краткое описание). Функция `extractUsedHelpers(expression)` парсит регуляркой имена функций перед `(` и возвращает `HelperDoc[]` для совпавших — используется в `EditorFormulaTooltip` для авто-показа справки по функциям, реально встретившимся в выражении. Один источник правды для `FormulaBuilder` (тултипы кнопок) и `TemplateEditorPage` (hover-подсказки над пилюлями). |
| [`apps/frontend/src/lib/useCurrentRole.ts`](./apps/frontend/src/lib/useCurrentRole.ts) | Хук `useCurrentRole()` (Фаза 6). TanStack Query вокруг `meApi.get()` (`GET /api/me`), `staleTime: Infinity`, enabled только если `isB24Available()`. Возвращает `{data, userId, role, isAdmin, isLoading, isError, error, refetch}`. Также экспортирует `useInvalidateRole()` (хук, возвращающий функцию `invalidateQueries(['me'])`) и константу `ME_QUERY_KEY`. |
| [`apps/frontend/src/lib/useApiError.ts`](./apps/frontend/src/lib/useApiError.ts) | Хук `useApiError()` и imperative-helper `reportApiError(err, fallbackTitle)` (Фаза 6). Распознаёт `ApiError`, обычный `Error`, строки. Подбирает русскоязычный заголовок по статусу (401/403/404/409/413/429/5xx/0). Вызывает `toast({variant: 'destructive'})` из `components/ui/use-toast.ts`. Возвращает `{status, message, code}`. |

**Pages** (заглушки, реализуются в Фазах 2–5):

| Файл | Назначение |
|---|---|
| [`apps/frontend/src/pages/InstallPage.tsx`](./apps/frontend/src/pages/InstallPage.tsx) | Первая установка. Дебаунс-поиск пользователей через `usersApi.search`, мульти-выбор админов в `Map<number, PortalUserDTO>`, сохранение через `installApi.install` + автоматический `installApi.registerPlacements`, редирект на `/templates`. |
| [`apps/frontend/src/pages/TemplatesPage.tsx`](./apps/frontend/src/pages/TemplatesPage.tsx) | Главная страница админа. Слева `<ThemeSidebar>`, справа: заголовок темы, дебаунс-поиск (`useDebouncedValue`) по имени шаблона, кнопка «Загрузить шаблон» в `<Dialog>` с `<TemplateUploader>` (обёрнута в `<AdminOnly>`), сетка карточек шаблонов выбранной темы. Кнопка «Открыть» (редактор) скрыта для не-админов через `useCurrentRole().isAdmin`. Запросы через `templatesApi.list({themeId, search})`. |
| [`apps/frontend/src/pages/TemplateEditorPage.tsx`](./apps/frontend/src/pages/TemplateEditorPage.tsx) | Редактор шаблона по `/templates/:id/edit`. Загружает шаблон через `templatesApi.get(id)`, рендерит `<Toolbar>` (с кнопкой Σ) + `<TiptapEditor>`, поля имени и темы, кнопку Сохранить. Управляет dirty-state и ошибками. Локальная карта `formulasByKey: Record<tagKey, FormulaInputDTO>` ведёт метаданные формул. Хелпер `extractFormulasFromEditor` обходит `editor.state.doc.descendants` и собирает массив formulas для `PUT /api/templates/:id`. Диалог `<FormulaBuilder>` открывается кнопкой Σ или кликом по существующей пилюле (delegated click listener на `editor.view.dom`); `handleInsertFormula` имеет режимы EDIT (`setNodeMarkup`) и INSERT (`insertFormulaTag`). Содержит вложенный компонент `EditorFormulaTooltip` — Google Sheets-style hover-подсказка для пилюль формул: слушает `mouseover/mouseout` на `editor.view.dom`, через 200 мс показывает portal-окно с label, expression, цветовыми чипами зависимостей DEAL/CONTACT/COMPANY и автоматически собранным списком используемых функций (`extractUsedHelpers` + `HelperTooltipContent`). |
| [`apps/frontend/src/pages/GeneratePage.tsx`](./apps/frontend/src/pages/GeneratePage.tsx) | Preview + генерация документа (Фаза 5). Три колонки: слева — сайдбар тем+шаблонов (`themesApi.list` → развёртывание выбранной темы с `templatesApi.list({themeId})`), центр — preview через `templatesApi.preview(id, dealId)` и `dangerouslySetInnerHTML` в `gen-preview-html`-контейнере со стилизацией `<span data-formula-key>` через инлайн `PREVIEW_STYLES`, справа — sidebar действий с кнопкой «Сгенерировать документ» (мутация `generateApi.generate`), результат (fileName, downloadUrl, binding, timeline, warnings[]), список формул шаблона. `useEffect` после рендера добавляет `title` атрибут к каждому formula-span с label/expression/value для native-tooltip. Если `getCurrentDealId()` возвращает null — рендерит stub с просьбой открыть из карточки сделки. |
| [`apps/frontend/src/pages/SettingsPage.tsx`](./apps/frontend/src/pages/SettingsPage.tsx) | Настройки приложения (Фаза 5). Секции: 1) Поле для сгенерированных файлов — `<select>` из `settingsApi.dealFields()` (только `USER_TYPE_ID=file`), с кнопкой «Создать поле» → Dialog с inputs для XML_ID (sanitized A-Z/0-9/_) и label → `settingsApi.createField` → refetch; 2) Администраторы — список текущих с кнопкой Trash + debounced поиск через `usersApi.search` + чекбоксы добавления; 3) Save-bar с `settingsApi.update({dealFieldBinding, adminUserIds})` и toast-стрипом. Использует `useDebouncedValue`, `ApiError`. |

**UI-компоненты shadcn/ui** (в `src/components/ui/`):

| Файл | Назначение |
|---|---|
| [`apps/frontend/src/components/ui/button.tsx`](./apps/frontend/src/components/ui/button.tsx) | `Button` + `buttonVariants` (CVA: variant/size). |
| [`apps/frontend/src/components/ui/input.tsx`](./apps/frontend/src/components/ui/input.tsx) | `Input` — обёртка над native `<input>`. |
| [`apps/frontend/src/components/ui/dialog.tsx`](./apps/frontend/src/components/ui/dialog.tsx) | `Dialog`, `DialogTrigger`, `DialogContent`, `DialogHeader`, `DialogFooter`, `DialogTitle`, `DialogDescription`, `DialogClose`, `DialogOverlay`, `DialogPortal` (Radix). |
| [`apps/frontend/src/components/ui/dropdown-menu.tsx`](./apps/frontend/src/components/ui/dropdown-menu.tsx) | `DropdownMenu` + `Trigger`, `Content`, `Item`, `CheckboxItem`, `RadioItem`, `Label`, `Separator`, `Sub*`, `Group` (Radix). |
| [`apps/frontend/src/components/ui/toast.tsx`](./apps/frontend/src/components/ui/toast.tsx) | `Toast`, `ToastProvider`, `ToastViewport`, `ToastAction`, `ToastClose`, `ToastTitle`, `ToastDescription` (Radix). |
| [`apps/frontend/src/components/ui/use-toast.ts`](./apps/frontend/src/components/ui/use-toast.ts) | Хук `useToast()` и imperative-функции `toast({title, description, variant, duration, action})`/`dismiss(id)` (Фаза 6). Простой in-memory store со списком слушателей и лимитом `TOAST_LIMIT=5`. Авто-удаление через `TOAST_REMOVE_DELAY=5s`. |
| [`apps/frontend/src/components/ui/toaster.tsx`](./apps/frontend/src/components/ui/toaster.tsx) | Хост-компонент `<Toaster>` (Фаза 6). Подписывается на `useToast()` и рендерит каждый toast внутри `<ToastProvider>` + `<ToastViewport swipeDirection="right">`. Монтируется один раз в `App.tsx`. |
| [`apps/frontend/src/components/ui/tabs.tsx`](./apps/frontend/src/components/ui/tabs.tsx) | `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` (Radix). |
| [`apps/frontend/src/components/ui/RichTooltip.tsx`](./apps/frontend/src/components/ui/RichTooltip.tsx) | Лёгкий тултип в стиле Google Sheets без зависимости от Radix. Оборачивает `children` в inline-flex span, на hover/focus с задержкой 250 мс показывает богатое содержимое (`ReactNode`) через `createPortal` в `document.body`. `useLayoutEffect` пересчитывает позицию: центрирование по горизонтали, клэмп по краям viewport, флип сверху↔снизу. Props: `content`, `children`, `delay`, `side`, `className`, `asBlock`. |

**Прочие компоненты** (в `src/components/`):

| Файл | Назначение |
|---|---|
| [`apps/frontend/src/components/PlacementGuard.tsx`](./apps/frontend/src/components/PlacementGuard.tsx) | Обёртка над всем route-tree. Проверяет `isB24Available()`, `GET /api/install/status`, читает `?view=` query-параметр и роутит по placement (`CRM_DEAL_DETAIL_TAB → /generate`, `DEFAULT → /templates`). При отсутствии установки редиректит на `/install`. После установки вызывает `useCurrentRole()`; если пользователь не админ и пытается открыть `/settings` (или `DEFAULT` placement, ведущий на настройки) — рендерит 403-stub вместо детей (Фаза 6). |
| [`apps/frontend/src/components/AdminOnly.tsx`](./apps/frontend/src/components/AdminOnly.tsx) | Wrapper-компонент `<AdminOnly>` (Фаза 6). Использует `useCurrentRole()` и рендерит `children` только если текущий пользователь — админ; иначе рендерит проп `fallback` (по умолчанию `null`). Во время загрузки роли тоже рендерит fallback, чтобы не было flash-а админских кнопок. |
| [`apps/frontend/src/components/ThemeSidebar.tsx`](./apps/frontend/src/components/ThemeSidebar.tsx) | Левый сайдбар тем (Фаза 3). Загружает темы через TanStack Query (`['themes']` ↔ `themesApi.list`). Кнопка «+» открывает `<Dialog>` для создания. На каждой теме `<DropdownMenu>` с пунктами Переименовать/Удалить. Удаление с 409 (есть шаблоны) показывается inline-баннером. Контролируемый выбор `selectedThemeId` через проп `onSelect`. Кнопка «+» и DropdownMenu действий по теме отрисовываются только для админа (`useCurrentRole().isAdmin`, Фаза 6). |
| [`apps/frontend/src/components/TemplateUploader.tsx`](./apps/frontend/src/components/TemplateUploader.tsx) | Drag&drop загрузка `.docx` (Фаза 3). Использует `react-dropzone` с фильтрами `application/vnd.openxmlformats-officedocument.wordprocessingml.document` и `maxSize: 20MB`. Прогресс через `templatesApi.upload` (XHR). Колбэки `onSuccess(template)` и `onError(message)`. Принимает `themeId` как required prop. |
| [`apps/frontend/src/components/Editor/TiptapEditor.tsx`](./apps/frontend/src/components/Editor/TiptapEditor.tsx) | TipTap-обёртка. `useEditor` с расширениями StarterKit + Image (`allowBase64`) + Table (resizable) + TableRow/TableHeader/TableCell + `FormulaTag` (inline atom-узел для формул). Контролируемый props: `content`, `onChange`, `editable`, `placeholder`. Экспортирует `buildTiptapExtensions()` для повторного использования. Колбэк `onReady(editor)` отдаёт инстанс редактора наружу для тулбара. |
| [`apps/frontend/src/components/Editor/Toolbar.tsx`](./apps/frontend/src/components/Editor/Toolbar.tsx) | Тулбар форматирования. Принимает `editor: Editor \| null` и опциональный `onInsertFormula`. Кнопки: bold/italic/strike, Heading 1/2/Paragraph, bullet/ordered list, вставка таблицы 3x3, вставка картинки (prompt URL), кнопка Σ «Вставить формулу» (только если задан `onInsertFormula`), undo/redo. Использует иконки lucide-react. |
| [`apps/frontend/src/components/Editor/index.ts`](./apps/frontend/src/components/Editor/index.ts) | Реэкспорт `TiptapEditor`, `Toolbar`, `buildTiptapExtensions` и связанных типов. |
| [`apps/frontend/src/components/FormulaTag.tsx`](./apps/frontend/src/components/FormulaTag.tsx) | Кастомный TipTap Node extension `formulaTag` (inline, atom). Атрибуты `tagKey`, `label`, `expression` сериализуются в `data-formula-key/label/expression`. `parseHTML` принимает `span[data-formula-key]`, `renderHTML` возвращает стилизованный pill с `Σ {label}`. Команда `insertFormulaTag(attrs)` и helper-функция `insertFormula(editor, attrs)`. |
| [`apps/frontend/src/components/FieldPicker.tsx`](./apps/frontend/src/components/FieldPicker.tsx) | Дерево CRM-полей для вставки токенов в выражение. Вкладки Сделка/Контакт/Компания (`Tabs` shadcn), поиск по коду или названию, рендер списка с типом поля. Данные грузит через `crmApi.allFields()` (TanStack Query, staleTime 5 минут, поэтому батч-запрос к `/api/crm/fields`). На клик вызывает `onSelect(token, field, entity)` с токеном вида `DEAL.OPPORTUNITY`. |
| [`apps/frontend/src/components/FormulaBuilder.tsx`](./apps/frontend/src/components/FormulaBuilder.tsx) | Модалка конструктора формул (shadcn Dialog). Сетка 2 колонки: слева — label, tagKey (авто-slug через `generateTagKey`, с флагом `tagKeyDirty`), монопространственная textarea, палитра операторов и helper-функций (if/concat/format/dateFormat/upper/lower) — каждая кнопка обёрнута в `<RichTooltip>` с богатой подсказкой в стиле Google Sheets: для функций — `HelperTooltipContent` (signature, описание, таблица аргументов, пример) из общего справочника `HELPER_DOCS` (`lib/formulaHelp.ts`), для операторов — описание из `OPERATOR_DOCS`. Блок предпросмотра (при наличии `testDealId` вызывает `formulasApi.evaluate`). Справа — `FieldPicker` и блок зависимостей. Live-валидация: `validateLocally` синхронно + debounce 500 мс `validateRemote`. Кнопка «Вставить» заблокирована при ошибках; на submit вызывает `onInsert({tagKey, label, expression, dependsOn})`. Экспортирует `HelperTooltipContent` для повторного использования в `EditorFormulaTooltip`. |

Подкаталоги `src/lib/`, `src/store/` дополняются по мере развития
(zustand-слайсы — Фаза 5).

### apps/backend

Fastify REST API на TypeScript. Использует Prisma для работы с SQLite.

| Файл | Назначение |
|---|---|
| [`apps/backend/package.json`](./apps/backend/package.json) | Манифест. Зависимости: `fastify`, `@fastify/cors`, `@fastify/multipart`, `@fastify/sensible`, `dotenv`, `@prisma/client`, `mammoth`, `mathjs`, `@turbodocx/html-to-docx`, `@b24-doc-gen/shared` (workspace:*). DevDeps: `tsx`, `prisma`, `pino-pretty`. Использует глобальный `fetch` (Node 18+) и `node:crypto` для HMAC. |
| [`apps/backend/tsconfig.json`](./apps/backend/tsconfig.json) | TS-конфиг (module NodeNext, path alias `@/*`, reference на `packages/shared`). |
| [`apps/backend/.env`](./apps/backend/.env) | Локальные переменные (DATABASE_URL, BACKEND_PORT, FRONTEND_URL, NODE_ENV). Не коммитится. |

#### apps/backend/src

| Файл | Назначение |
|---|---|
| [`apps/backend/src/server.ts`](./apps/backend/src/server.ts) | Точка входа. Экспортирует `buildServer()` — фабрику Fastify-инстанса (регистрирует CORS, multipart, sensible, B24 auth middleware, маршруты health/deal/users/install/themes/templates/formulas/settings/generate/me) — и `start()` — процесс-уровневый запуск на `BACKEND_PORT`. В Фазе 6 добавлен централизованный `setErrorHandler` — все ошибки конвертируются в `{error: {code, message, details?}}`, 5xx логгируются через `request.log.error` с stack, в dev-режиме stack включается в `details`. |
| [`apps/backend/src/routes/health.ts`](./apps/backend/src/routes/health.ts) | `registerHealthRoute(app)` — регистрирует `GET /health`, возвращает `{status, service, uptime, timestamp}`. |
| [`apps/backend/src/routes/me.ts`](./apps/backend/src/routes/me.ts) | `registerMeRoutes(app)` (Фаза 6) — `GET /api/me`. Возвращает `{userId, role}` где `role: 'admin' | 'user'` определяется через `loadCurrentRole(request)` (см. `middleware/role.ts`). Используется фронтендом для решения, какие UI-элементы показывать. |
| [`apps/backend/src/routes/deal.ts`](./apps/backend/src/routes/deal.ts) | `registerDealRoutes(app)` — `GET /api/deal/:id/fields` (кеш TTL 5 минут per portal), `GET /api/crm/fields` (объединённый батч-ответ с полями для Deal/Contact/Company, кешируется тремя отдельными `TTLCache` инстансами), `GET /api/deal/:id/data` (двухступенчатый `callBatch`: deal+contacts → contact+company). Экспортирует `invalidateDealFieldsCache()`. |
| [`apps/backend/src/routes/formulas.ts`](./apps/backend/src/routes/formulas.ts) | `registerFormulaRoutes(app)` (Фаза 4) — `POST /api/formulas/validate` (использует `formulaEngine.validateExpression`, возвращает `{valid, error?, dependencies}`) и `POST /api/formulas/evaluate` (при наличии `dealId` собирает контекст через двухступенчатый batch как в `deal.ts`, поддерживает inline `context` override, вызывает `formulaEngine.evaluateExpression`, возвращает `{ok, value, raw, error?, dependencies}`). |
| [`apps/backend/src/routes/users.ts`](./apps/backend/src/routes/users.ts) | `registerUsersRoutes(app)` — `GET /api/users?search=&start=` (нормализует `user.get` в `PortalUser[]` со стабильной формой `id/name/lastName/fullName/email/active`). |
| [`apps/backend/src/routes/install.ts`](./apps/backend/src/routes/install.ts) | `registerInstallRoutes(app)` — `GET /api/install/status`, `POST /api/install` (upsert `AppSettings` id=1, JSON-encoded `adminUserIds`, portal из `request.b24Auth`, после upsert вызывает `invalidateRoleCache()`), `POST /api/install/register-placements` (placement.bind для `CRM_DEAL_DETAIL_TAB` и `DEFAULT`). Экспортирует `toAppSettings(row)`. |
| [`apps/backend/src/routes/themes.ts`](./apps/backend/src/routes/themes.ts) | `registerThemeRoutes(app)` — CRUD тем шаблонов: `GET /api/themes` (сортировка по `order` ASC, затем по имени, с `_count.templates`), `POST /api/themes` (новая тема, order по умолчанию = max+1), `PUT /api/themes/:id` (обновление name/order), `DELETE /api/themes/:id` (возвращает 409, если есть привязанные шаблоны). Экспортирует `ThemeDTO`. Mutation-роуты POST/PUT/DELETE гейтятся `requireAdmin` (Фаза 6, см. `middleware/role.ts`). |
| [`apps/backend/src/routes/templates.ts`](./apps/backend/src/routes/templates.ts) | `registerTemplateRoutes(app)` — CRUD шаблонов и multipart-загрузка `.docx`: `GET /api/templates?themeId=&search=` (фильтр по теме + поиск contains по имени, с `themeName` и `_count.formulas`), `GET /api/templates/:id?withDocx=1` (шаблон + массив формул, опционально base64 оригинала), `GET /api/templates/:id/preview?dealId=` (Фаза 5: загружает шаблон + формулы, через `getDealContext` собирает контекст сделки, вычисляет каждую формулу через `formulaEngine.evaluateExpression`, перезаписывает HTML через `substituteFormulaTagsForPreview` (regex-замена `<span data-formula-key>` на computed value + `data-computed-value` атрибут), возвращает `TemplatePreviewResponse` с `html` и `formulas[tagKey]`), `POST /api/templates` (создать пустой), `POST /api/templates/upload` (multipart, max 20MB, валидация .docx-расширения и mime, парсинг через `docxParser`, сохранение `originalDocx` в Bytes), `PUT /api/templates/:id` (транзакционное обновление name/themeId/contentHtml + замена массива formulas), `DELETE /api/templates/:id` (удаляет formulas + template). Экспортирует `TemplateListItemDTO`, `TemplateDTO`, `FormulaInput`. Mutation-роуты POST `/api/templates`, POST `/api/templates/upload`, PUT `/api/templates/:id`, DELETE `/api/templates/:id` гейтятся `requireAdmin` (Фаза 6). |
| [`apps/backend/src/routes/settings.ts`](./apps/backend/src/routes/settings.ts) | `registerSettingsRoutes(app)` (Фаза 5) — `GET /api/settings` (текущая `AppSettings`), `PUT /api/settings` (обновление `dealFieldBinding` и/или `adminUserIds`, валидирует `UF_CRM_*` формат, после смены `adminUserIds` зовёт `invalidateRoleCache()`), `GET /api/settings/deal-fields` (через `b24Client.listDealUserFields`, фильтр по `USER_TYPE_ID = file`, нормализация в `DealFileFieldDTO[]` с локализованными метками через `pickLocalized`), `POST /api/settings/create-field` (создаёт `UF_CRM_*` поле через `b24Client.addDealUserField` с `USER_TYPE_ID: file`, обработка дублей XML_ID как 409). Использует `toAppSettings()` из `install.ts`. Mutation-роуты PUT `/api/settings` и POST `/api/settings/create-field` гейтятся `requireAdmin` (Фаза 6). |
| [`apps/backend/src/routes/generate.ts`](./apps/backend/src/routes/generate.ts) | `registerGenerateRoutes(app)` (Фаза 5) — `POST /api/generate { templateId, dealId }`. Конвейер: 1) загрузка template+formulas из Prisma и `AppSettings`, 2) `getDealContext(client, dealId)` — двухступенчатый batch для DEAL+CONTACT+COMPANY, 3) `evaluateExpression` для каждой формулы → `formulaResults[tagKey]`, 4) `buildDocxFromHtml(contentHtml, {formulas, title})` → Buffer, 5) `disk.storage.getforapp` → `ROOT_OBJECT_ID`, 6) `b24Client.uploadDiskFile(folderId, fileName, buffer)`, 7) опциональный `crm.deal.update` через `AppSettings.dealFieldBinding` (warning если не настроено), 8) `crm.timeline.comment.add` со ссылкой. Возвращает `GenerateRouteResponse {fileId, fileName, downloadUrl, formulas, binding, timeline, warnings[]}`. Все сторонние шаги non-fatal — fatal только template/dealContext/upload. |
| [`apps/backend/src/middleware/auth.ts`](./apps/backend/src/middleware/auth.ts) | `registerAuthMiddleware(app)` — preHandler hook на `/api/*` (кроме `/api/health`), извлекает `X-B24-Access-Token`/`Member-Id`/`Domain` (или body.auth), валидирует через `verifyB24Payload`, опционально проверяет HMAC-подпись (`B24_APP_SECRET`), заполняет `request.b24Auth`. Экспортирует `B24RequestAuth`, `verifyB24Payload`, `isPlausibleBitrixDomain`. Расширяет тип `FastifyRequest`. |
| [`apps/backend/src/middleware/role.ts`](./apps/backend/src/middleware/role.ts) | Role-based access control (Фаза 6). `requireAdmin(request, reply)` — Fastify preHandler, отдаёт 403 если `request.b24Auth.userId` отсутствует в `AppSettings.adminUserIds`. `loadCurrentRole(request)` — резолвит роль не бросая исключений (используется в `routes/me.ts`). Внутри — in-memory cache набора admin id (`Set<number>`) с TTL 30 секунд. `invalidateRoleCache()` сбрасывает кеш — вызывается из `routes/install.ts` (после upsert) и `routes/settings.ts` (после смены adminUserIds). |
| [`apps/backend/src/services/b24Client.ts`](./apps/backend/src/services/b24Client.ts) | Класс `B24Client({portal, accessToken, fetchImpl?, timeoutMs?})`. Методы: `callMethod`, `callBatch`, `getDeal`, `getDealFields` (нормализует в `DealField[]`), `getContactFields`, `getCompanyFields`, `listDealUserFields`, `addDealUserField`, `updateDeal`, `getContact`, `getCompany`, `getDealContacts`, `addTimelineComment`, `listUsers`, `uploadDiskFile`. Класс ошибок `B24Error(code, status, details)`. Сериализует параметры батча в PHP-стиль (`fields[NAME]=foo`). |
| [`apps/backend/src/services/cache.ts`](./apps/backend/src/services/cache.ts) | `TTLCache<V>` — простой in-memory кеш с per-key TTL. Методы: `get`, `set`, `delete`, `clear`, `size`. |
| [`apps/backend/src/services/docxParser.ts`](./apps/backend/src/services/docxParser.ts) | `parseDocxToHtml(buffer: Buffer)` — конвертация `.docx` в HTML через mammoth.js. Использует кастомный `defaultStyleMap` (Heading 1/2/3, русские «Заголовок 1/2/3», Title/Subtitle, Strong/Emphasis, Quote). Возвращает `{html, messages}`. Бросает `DocxParseError` при пустом буфере или ошибке парсинга. |
| [`apps/backend/src/services/formulaEngine.ts`](./apps/backend/src/services/formulaEngine.ts) | Sandboxed mathjs-движок для формул шаблонов (Фаза 4). Приватная инстанция `math = create(all)` с заблокированными небезопасными функциями (`import`, `createUnit`, `simplify`, `derivative`, `rationalize`, `resolve`, `symbolicEqual`, `reviver`, `replacer`). Регистрирует helper-функции: `if(cond, a, b)`, `concat(...args)`, `format(value, pattern)` (0/0.00/0.0%/money/usd/eur), `dateFormat(date, fmt)` (iso/date/datetime/dd.MM.yyyy с токенами yyyy/yy/MM/dd/HH/mm/ss), `upper(s)`, `lower(s)`. Публичный API: `validateExpression(expression)` (возвращает `{ok, error?, deps?}`), `evaluateExpression(expression, context)` (возвращает `{value, raw, error?}` с контекстом `{DEAL, CONTACT, COMPANY}`), `extractDependencies(expression)` (статическая выборка `FormulaDependencies` через AccessorNode обход AST). Также экспортирует `formatNumber` и `formatDate` как отдельные утилиты. |
| [`apps/backend/src/services/dealData.ts`](./apps/backend/src/services/dealData.ts) | Сервис сборки контекста сделки (Фаза 5). `getDealContext(client, dealId): Promise<FormulaContext>` — двухступенчатый batch: 1) `crm.deal.get` + `crm.deal.contact.items.get`, 2) `crm.contact.get` + `crm.company.get` (только если есть соответствующие id). Через `flattenEntity`/`flattenValue` нормализует мульти-значения (PHONE/EMAIL/WEB/IM как массивы `{VALUE,...}`) в скаляр (первый VALUE). Возвращает плоский `{DEAL, CONTACT, COMPANY}`. Бросает `DealDataError(message, code, status)` если deal не найден. Экспортирует `__internal` для тестов. |
| [`apps/backend/src/services/docxBuilder.ts`](./apps/backend/src/services/docxBuilder.ts) | Сервис генерации `.docx` из HTML (Фаза 5). `buildDocxFromHtml(html, {formulas?, title?}): Promise<Buffer>` через `@turbodocx/html-to-docx`. Перед конвертацией `stripFormulaTags` regex-заменой подставляет computed values вместо `<span data-formula-key>` (на ошибке использует label, без формулы — снимает префикс «Σ »). `wrapAsHtmlDocument` оборачивает в HTML5 shell с `lang=ru` UTF-8 для корректной кириллицы. Параметры html-to-docx: portrait, Arial, fontSize 22 (11pt), A4 margins 1440 twips, table borders. Результат нормализуется в Node Buffer через `coerceToBuffer`. Бросает `DocxBuildError`. Экспортирует `__internal` для тестов. |
| [`apps/backend/src/prisma/client.ts`](./apps/backend/src/prisma/client.ts) | Экспорт singleton-экземпляра `PrismaClient` с защитой от утечек при hot-reload (кеш на `globalThis.__prismaClient`). |

#### apps/backend/prisma

| Файл | Назначение |
|---|---|
| [`apps/backend/prisma/schema.prisma`](./apps/backend/prisma/schema.prisma) | Схема БД. Модели: `AppSettings`, `Theme`, `Template`, `Formula`. Datasource `sqlite` → `file:./dev.db`. |
| [`apps/backend/prisma/migrations/`](./apps/backend/prisma/migrations/) | Миграции Prisma. Первая миграция `*_init/migration.sql` создаёт все 4 модели. |

**Модели Prisma** (подробнее см. [`schema.prisma`](./apps/backend/prisma/schema.prisma)):

- **AppSettings** — `id` (Int @default(1)), `portalDomain`, `adminUserIds` (JSON-строка), `dealFieldBinding?`, `installedAt`. Singleton-настройки приложения.
- **Theme** — `id` (cuid), `name`, `order`, `templates[]`, `createdAt`, `updatedAt`. Группировка шаблонов.
- **Template** — `id` (cuid), `name`, `themeId` → Theme, `contentHtml` (TipTap HTML), `originalDocx?` (Bytes), `formulas[]`. Индекс по `themeId`.
- **Formula** — `id` (cuid), `templateId` → Template (onDelete: Cascade), `tagKey`, `label`, `expression`, `dependsOn` (JSON-строка). Unique `(templateId, tagKey)`.

## Поток данных (высокоуровневый)

1. **Установка:** фронтенд детектит отсутствие `AppSettings` → `InstallPage` → `POST /api/install` → backend сохраняет настройки.
2. **Загрузка шаблона:** админ загружает `.docx` → `docxParser` (mammoth) → HTML → TipTap → `PUT /api/templates/:id`.
3. **Вставка формулы:** `FormulaBuilder` → выбор полей через `FieldPicker` (получает `crm.deal.fields`) → валидация mathjs → вставка `<formula-tag>` в TipTap.
4. **Генерация:** `GeneratePage` → `GET /api/templates/:id/preview?dealId=` → backend собирает данные (`dealData`), вычисляет формулы → HTML с подстановкой → `POST /api/generate` → `docxBuilder` → `disk.folder.uploadfile` → `crm.deal.update` → `crm.timeline.comment.add`.

## Роли и безопасность

Приложение различает две роли:

- **admin** — Bitrix24-пользователь, чей `userId` присутствует в
  `AppSettings.adminUserIds`. Может создавать/редактировать/удалять
  темы, шаблоны, формулы и менять настройки.
- **user** — любой другой пользователь портала, имеющий доступ к
  iframe приложения. Может только генерировать документы по готовым
  шаблонам в карточке сделки.

### Backend

- Глобальный `registerAuthMiddleware` гейтит все `/api/*` маршруты,
  валидирует Bitrix24-headers и заполняет `request.b24Auth`.
- `requireAdmin` (см. [`apps/backend/src/middleware/role.ts`](./apps/backend/src/middleware/role.ts))
  применяется как `preHandler` на ВСЕХ mutation-роутах:
  - POST/PUT/DELETE `/api/themes(/:id)`
  - POST `/api/templates`, POST `/api/templates/upload`,
    PUT/DELETE `/api/templates/:id`
  - PUT `/api/settings`, POST `/api/settings/create-field`
- `loadCurrentRole(request)` — резолвит роль без 403, используется
  `GET /api/me` для отдачи `{userId, role}` фронтенду.
- `invalidateRoleCache()` зовётся из `routes/install.ts` после первой
  установки и из `routes/settings.ts` после смены `adminUserIds`,
  чтобы закешированный набор админ-id не отставал от БД.
- Централизованный `setErrorHandler` в [`server.ts`](./apps/backend/src/server.ts)
  возвращает все ошибки в формате `{error: {code, message, details?}}`,
  логгирует 5xx через `request.log.error` со stack-трейсом, а в dev
  режиме включает stack в `details`.

### Frontend

- [`useCurrentRole()`](./apps/frontend/src/lib/useCurrentRole.ts) —
  TanStack Query поверх `meApi.get()`, кешируется на сессию
  (`staleTime: Infinity`). Возвращает `{role, isAdmin, isLoading, ...}`.
- [`<AdminOnly>`](./apps/frontend/src/components/AdminOnly.tsx) —
  обёртка, рендерит детей только для админа. Используется в
  `TemplatesPage` и `ThemeSidebar` чтобы скрыть «Загрузить шаблон»,
  «Создать тему», «Переименовать», «Удалить», «Открыть редактор».
- [`PlacementGuard`](./apps/frontend/src/components/PlacementGuard.tsx)
  после установки приложения резолвит роль и для любого пути под
  `/settings` отдаёт 403-stub если пользователь не админ — это страховка
  на случай, если кто-то откроет URL вручную минуя UI-кнопки.
- Все ошибки от `apiRequest`/`uploadRequest` пробрасываются в UI как
  `ApiError` (см. [`apps/frontend/src/lib/api.ts`](./apps/frontend/src/lib/api.ts));
  для единообразного показа toast-ов есть хук
  [`useApiError()`](./apps/frontend/src/lib/useApiError.ts) и
  imperative-функция `reportApiError(err, fallbackTitle)`. Глобальный
  `<Toaster>` смонтирован в [`App.tsx`](./apps/frontend/src/App.tsx).

## Workspace команды

Из корня проекта:

```bash
pnpm install              # установить всё
pnpm dev                  # параллельный dev (frontend + backend)
pnpm dev:frontend         # только Vite
pnpm dev:backend          # только Fastify
pnpm build                # сборка всех пакетов
pnpm typecheck            # tsc --noEmit по всем
pnpm -F backend db:push   # синхронизация Prisma-схемы с SQLite
pnpm -F backend db:migrate # создание миграции
```
