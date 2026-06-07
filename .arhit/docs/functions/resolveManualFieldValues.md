# resolveManualFieldValues

Хелпер generationPipeline.ts: строит финальную карту значений ручных полей. Если ключ есть в rawValues (даже пустая строка) — используется как есть; если ключ отсутствует — подставляется дефолт (resolveFieldDefault): для date+today → todayRu() (dd.MM.yyyy), для text/textarea/number → литеральное defaultValue. UI шлёт все ключи (может перебить дефолт очисткой), webhook без значений получает дефолты. Используется в routes/generate.ts и runGeneration.
