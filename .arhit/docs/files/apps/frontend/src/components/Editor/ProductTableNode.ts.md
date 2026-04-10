# apps/frontend/src/components/Editor/ProductTableNode.ts

Кастомные TipTap inline atom ноды для product-таблиц. ProductFieldSpan парсит <span data-product-field> и рендерит emerald-пилюлю с именем поля. ProductImageSpan парсит <span data-product-image> и рендерит purple-пилюлю. ProductIndexSpan парсит <span data-product-index> и рендерит gray-пилюлю с символом #. Все три расширения регистрируются в buildTiptapExtensions() в TiptapEditor.tsx.
