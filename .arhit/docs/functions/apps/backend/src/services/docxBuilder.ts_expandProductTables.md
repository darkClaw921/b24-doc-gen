# apps/backend/src/services/docxBuilder.ts:expandProductTables

Функция expandProductTables(html, products) раскрывает product-таблицы в HTML. Находит <table data-product-table="true">, берёт последний <tr> в <tbody> как шаблонную строку, клонирует N раз по числу товаров. Замена плейсхолдеров: data-product-field → значение поля, data-product-image → img tag с base64, data-product-index → порядковый номер. Вызывается перед stripFormulaTags в buildDocxFromHtml pipeline.
