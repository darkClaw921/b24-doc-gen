# apps/backend/src/services/docxBuilder.ts

Сервис Фазы 5: buildDocxFromHtml(html, {formulas?, title?}): Promise<Buffer> через @turbodocx/html-to-docx. stripFormulaTags заменяет <span data-formula-key> на computed value (или label при ошибке) regex-replace. wrapAsHtmlDocument оборачивает в HTML5 shell с UTF-8 lang=ru. Параметры: portrait, Arial, fontSize 22, margins 1440 twips A4, table borders. Возвращает Node Buffer через coerceToBuffer (поддерживает Buffer/ArrayBuffer/Blob). DocxBuildError на пустой вход или сбой конвертера.
