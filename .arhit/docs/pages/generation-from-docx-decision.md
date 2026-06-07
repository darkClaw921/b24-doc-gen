Архитектурное решение: генерация и preview документов идут ПРЯМО из оригинального .docx, без HTML-промежутка.

ПРОБЛЕМА (что было): старый пайплайн конвертировал .docx → HTML (mammoth, docxParser.ts), редактировался в TipTap-WYSIWYG, затем рендерился обратно в PDF (Puppeteer, pdfBuilder.ts) или .docx (@turbodocx/html-to-docx, docxBuilder.ts). На каждом переходе терялось форматирование Word: выравнивание (w:jc), отступы (w:ind), красная строка, интервалы, табуляции, шрифты. Документы юристов (заявления в страховые) требуют форматирования 1:1.

РЕШЕНИЕ: docxTemplateEngine.buildDocxFromTemplate подставляет значения прямо в исходный .docx через docxtemplater (PizZip разбирает архив, подстановка в document.xml на месте). Word-форматирование полностью сохраняется, потому что мы не пересобираем документ — только заменяем плейсхолдеры { } внутри существующего XML.

МОДЕЛЬ РАЗМЕТКИ: админ расставляет плейсхолдеры в Word ({tagKey} формулы, {fieldKey} ручные поля, {#products}...{/products} цикл товаров, {%image} картинки), затем в редакторе (TemplateEditorPage, панель «Теги шаблона») привязывает к каждому тегу формулу или ручное поле. Размещение тегов — в .docx, привязки — в БД (formulas[]/fields[]).

PREVIEW: backend POST /api/templates/:id/preview возвращает подставленный .docx (docxBase64); фронтенд рендерит его в браузере через docx-preview renderAsync (и в GeneratePage, и read-only оригинал в TemplateEditorPage).

DEPRECATED (мёртвый код, помечен @deprecated, удаление отдельной задачей): pdfBuilder.ts (Puppeteer), docxBuilder.ts (html-to-docx, buildDocxFromHtml/expandProductTables), весь TipTap-фронтенд (удалён физически: components/Editor/*, FormulaTag.tsx, ManualFieldTag.tsx + @tiptap/* зависимости). docxParser.ts (mammoth) сохранён только для заполнения Template.contentHtml при загрузке (по нему generationPipeline эвристически решает, грузить ли товары/картинки).