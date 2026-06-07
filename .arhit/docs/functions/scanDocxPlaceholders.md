# scanDocxPlaceholders

scanDocxPlaceholders(originalDocx: Buffer): string[] — открывает .docx через PizZip и собирает уникальные имена плейсхолдеров { } из document.xml (через InspectModule docxtemplater). Используется: (1) при загрузке шаблона (templates.ts POST /upload → docxPlaceholders) и в toTemplateDto (?withDocx) для панели «Теги шаблона» редактора; (2) в preview-endpoint для поля tags. Возвращает плоский список тегов без контекста сделки; зарезервированные продуктовые теги фильтрует уже фронтенд (isReservedTag).
