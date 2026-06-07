# buildPdfFromHtml

Генерирует PDF из HTML через Puppeteer (headless Chrome). wrapAsStyledHtml оборачивает контент в print-ready HTML5 (Times New Roman, A4, поля 20/15mm). В body выставлен overflow-wrap: break-word — длинные неразрывные последовательности (например линии подписи из подчёркиваний '____', вставленные из КонсультантПлюс) переносятся вместо горизонтального overflow за край листа A4. Свойство наследуется потомками и безопасно для таблиц (не влияет на min-content). Pipeline: expandProductTables -> stripFormulaTags -> stripManualFieldTags -> wrapAsStyledHtml -> page.pdf.
