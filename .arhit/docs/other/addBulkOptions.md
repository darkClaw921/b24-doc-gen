# addBulkOptions

Обработчик в ManualFieldBuilder (компонент): берёт текст из bulkText, парсит через parseBulkOptions(bulkText, valueMode==='mapped'), удаляет пустые строки-плейсхолдеры из текущих options, добавляет новые варианты с дедупликацией по label, очищает bulkText. Привязан к кнопке 'Разобрать' в блоке 'Вставить списком'.
