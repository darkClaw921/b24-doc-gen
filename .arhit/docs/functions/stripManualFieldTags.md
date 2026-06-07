# stripManualFieldTags

Приватная функция pdfBuilder.ts: заменяет каждый <span data-field-key='K'>…</span> на значение fieldValues[K] (escapeHtml, переносы строк → <br>), пустая строка если значения нет. Вызывается в buildPdfFromHtml после stripFormulaTags.
