# buildPdfFromHtml

Генерация PDF из HTML через Puppeteer. Опции BuildPdfOptions: formulas?, title?, products?, fieldValues?. Pipeline: expandProductTables → stripFormulaTags → stripManualFieldTags → wrapAsStyledHtml → рендер в headless Chrome → page.pdf A4. Основной генератор (UI-роут и webhook-конвейер).
