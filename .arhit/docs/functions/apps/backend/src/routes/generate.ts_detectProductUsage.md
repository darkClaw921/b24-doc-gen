# apps/backend/src/routes/generate.ts:detectProductUsage

Приватная функция сканирования шаблона на использование товаров. Проверяет HTML на наличие data-product-table и data-product-image атрибутов, а выражения формул — на вызовы productSum/productCount/productGet/productImage. Возвращает {fetchProducts, fetchProductImages} флаги для getDealContext.
