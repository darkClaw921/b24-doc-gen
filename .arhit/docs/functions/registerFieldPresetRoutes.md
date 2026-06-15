# registerFieldPresetRoutes

Бэкенд CRUD-маршруты переиспользуемых пресетов выпадающих списков: GET/POST/PUT/DELETE /api/field-presets. Мутации под requireAdmin. options хранится JSON-строкой (parseOptions/normalizeOptions/JSON.stringify), toPresetDto приводит к shared FieldPreset. Валидация: name 1..200, ≥1 вариант, valueMode direct/mapped. Зарегистрирован в server.ts. Пресеты используются в ManualFieldBuilder для заполнения options+valueMode select-поля.
