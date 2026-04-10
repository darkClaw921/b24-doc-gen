# apps/backend/src/services/docxTemplateEngine.ts

# docxTemplateEngine.ts — Прямой движок .docx шаблонов

## Назначение
Модуль для подстановки плейсхолдеров непосредственно в .docx шаблон через docxtemplater, минуя промежуточный HTML-шаг. Сохраняет оригинальное форматирование Word-документа — шрифты, стили, таблицы, колонтитулы — в отличие от HTML-пайплайна (docxBuilder.ts), который теряет часть форматирования при конвертации.

## Почему существует
Пользователи загружают свои .docx-шаблоны с фирменным оформлением. HTML-конвертация неизбежно теряет сложное форматирование. Этот движок работает с .docx напрямую: открывает ZIP-архив (PizZip), парсит XML внутри через docxtemplater, подставляет значения и генерирует новый .docx без потери оформления.

## Ключевые функции

### buildDocxFromTemplate(originalDocx: Buffer, options: BuildFromTemplateOptions): Promise<Buffer>
Основная функция генерации. Принимает оригинальный .docx буфер и опции с формулами/продуктами. Шаги:
1. Валидация входного буфера (EMPTY_DOCX)
2. Открытие ZIP-архива через PizZip (ZIP_FAILED)
3. Построение data-объекта через buildDataObject()
4. Создание ImageModule для {%TAG} плейсхолдеров
5. Компиляция шаблона Docxtemplater (COMPILE_FAILED)
6. Рендеринг с данными (RENDER_FAILED)
7. Генерация выходного .docx буфера (GENERATE_FAILED)

Параметры nullGetter и delimiters настроены: пустые строки для отсутствующих тегов, фигурные скобки как разделители.

### scanDocxPlaceholders(originalDocx: Buffer): string[]
Извлекает все имена плейсхолдеров из .docx шаблона без рендеринга. Использует InspectModule из docxtemplater (CJS sub-path: docxtemplater/js/inspect-module.js). Возвращает отсортированный массив уникальных имён тегов. Используется в:
- templates.ts при загрузке шаблона (POST /api/templates/upload) — возвращает список плейсхолдеров клиенту
- generate.ts и generationPipeline.ts — валидация формул против плейсхолдеров перед генерацией (non-fatal warnings)

### buildDataObject(formulas, products): Record<string, unknown>
Внутренняя функция. Строит объект данных для docxtemplater.render():
- Каждый formula result маппится как data[tagKey] = value (или label при ошибке)
- Продукты маппятся в data.products[] с полями: INDEX, PRODUCT_NAME, PRICE, QUANTITY, DISCOUNT_SUM, TAX_RATE, SUM, MEASURE_NAME, SORT, PRODUCT_ID, ID, PREVIEW_PICTURE_BASE64, DETAIL_PICTURE_BASE64, MORE_PHOTO_BASE64

### createImageModule(): unknown
Создаёт экземпляр docxtemplater-image-module-free для обработки {%TAG} изображений. Конвертирует data:image/ base64 URI в ArrayBuffer. Размер по умолчанию: 150x150px.

### base64DataURLToArrayBuffer(dataURL: string): ArrayBuffer | false
Конвертирует data:image/ URI в ArrayBuffer для вставки в .docx. Поддерживает форматы: png, jpg, jpeg, gif, svg, svg+xml, webp, bmp.

### collectTagNames(tags, out, prefix): void
Рекурсивно собирает имена тегов из вложенного объекта InspectModule.getAllTags(). Обрабатывает как простые теги ({tagName: {}}), так и секции циклов ({sectionName: {nestedTag: {}}}).

## Интерфейс BuildFromTemplateOptions
- formulas: Record<string, FormulaEvaluationResult> — результаты вычисления формул по tagKey
- products?: ProductRow[] — товарные позиции сделки для {#products} циклов
- title?: string — информационный заголовок (не используется при рендеринге)

## Класс DocxTemplateError
Наследует Error. Поля: message, code (string).
Коды ошибок:
- EMPTY_DOCX — пустой входной буфер
- ZIP_FAILED — не удалось открыть .docx как ZIP-архив
- COMPILE_FAILED — ошибка компиляции шаблона docxtemplater
- RENDER_FAILED — ошибка рендеринга (подстановки данных)
- GENERATE_FAILED — ошибка генерации выходного буфера

## Конвенция плейсхолдеров
- {tagKey} — простое значение (текст, число)
- {#products}...{/products} — цикл по массиву товарных позиций
- {%IMAGE_TAG} — изображение (base64 data URI) на уровне документа
- {%PREVIEW_PICTURE_BASE64}, {%DETAIL_PICTURE_BASE64} — изображения товаров внутри {#products} цикла

## Интеграция
- generate.ts: если template.originalDocx !== null, вызывает buildDocxFromTemplate вместо buildDocxFromHtml
- generationPipeline.ts: аналогичная ветвящаяся логика для shared pipeline
- templates.ts: scanDocxPlaceholders вызывается при POST /api/templates/upload для возврата списка плейсхолдеров

## Зависимости
- pizzip — работа с ZIP-архивами .docx
- docxtemplater — парсинг и рендеринг шаблонов
- docxtemplater-image-module-free — поддержка {%TAG} изображений
- @b24-doc-gen/shared — типы FormulaEvaluationResult, ProductRow

## Технические заметки
- PizZip и docxtemplater имеют типы, но docxtemplater-image-module-free и InspectModule — нет (используется @ts-ignore и any)
- InspectModule загружается через require() (CJS sub-path export)
- paragraphLoop: true позволяет циклам работать на уровне параграфов
- linebreaks: true — поддержка переносов строк в значениях
