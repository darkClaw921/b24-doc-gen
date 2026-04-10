# apps/backend/src/services/docxBuilder.ts:stripFormulaTags

Функция stripFormulaTags заменяет span[data-formula-key] на вычисленные значения формул. Если значение формулы начинается с data:image/ (например от productImage()), генерирует img tag вместо текстового escape. Это позволяет вставлять картинки товаров в произвольные места шаблона.
