# apps/backend/src/services/pdfBuilder.ts

@deprecated LEGACY (мёртвый код, помечен на удаление). Генерация PDF из HTML через Puppeteer. Активный пайплайн (генерация + preview) переключён на docxTemplateEngine.buildDocxFromTemplate (.docx без HTML-шага), поэтому этот модуль НЕ импортируется ни одним файлом активного пути. buildPdfFromHtml(html, {formulas?, title?, products?, fieldValues?}) сохранён только для справки и legacy-диагностики (scripts/render-check.ts). Не возвращать в routes/generate.ts или generationPipeline.
