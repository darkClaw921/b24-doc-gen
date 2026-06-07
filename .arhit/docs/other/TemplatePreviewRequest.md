# TemplatePreviewRequest

Request body для POST /api/templates/:id/preview (Фаза 2). dealId: number — Bitrix24 deal ID для построения формул/продуктового контекста; fieldValues?: Record<string,string> — значения ручных полей по fieldKey, отсутствующие ключи берут дефолт поля. Зеркалит входы генерации (GenerateRequest), т.к. preview переиспользует тот же движок buildDocxFromTemplate.
