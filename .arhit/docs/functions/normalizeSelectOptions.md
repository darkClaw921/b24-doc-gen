# normalizeSelectOptions

В routes/templates.ts. Валидирует и нормализует массив вариантов select-поля: отбрасывает записи с пустым label, тримит и обрезает label/value до 500 символов, ограничивает количество 200 (SELECT_MAX_OPTIONS). parseSelectOptions парсит JSON-колонку options обратно в массив. normalizeValueMode приводит режим к 'direct'|'mapped'.
