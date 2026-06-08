# resolveManualFieldValues

Строит финальную карту fieldKey->строка для подстановки в .docx. Для каждого поля берёт переданное значение (даже пустую строку уважает) либо дефолт (resolveFieldDefault) при отсутствии ключа, затем пропускает через resolveSelectValue (маппинг select). Используется тремя путями: генерация (generationPipeline runGeneration), preview (routes/templates.ts) и hard-валидация required (routes/generate.ts).
