# apps/backend/src/services/docxBuilder.ts

@deprecated LEGACY (мёртвый код, помечен на удаление). Генерация .docx из HTML через @turbodocx/html-to-docx (buildDocxFromHtml) + expandProductTables. Активный пайплайн рендерит напрямую из оригинального .docx через buildDocxFromTemplate, поэтому buildDocxFromHtml/expandProductTables не вызываются из активного пути (импорт expandProductTables удалён из templates.ts; остаётся только self-import в pdfBuilder.ts, тоже deprecated). Не возвращать HTML→.docx путь.
