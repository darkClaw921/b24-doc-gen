# apps/frontend/src/lib/selectOptions.ts

Чистые хелперы редактирования вариантов списочного поля (без React). parseBulkOptions(text, splitValue) — построчный парсинг вставленного списка (mapped: label/value по табу или 2+ пробелам; direct: вся строка — вариант; пустые игнорируются). mergeParsedOptions(existing, parsed) — добавляет с отбрасыванием пустых placeholder и дедупом по trimmed label. Используется SelectOptionsEditor (реэкспортит parseBulkOptions). Покрыто selectOptions.test.ts.
