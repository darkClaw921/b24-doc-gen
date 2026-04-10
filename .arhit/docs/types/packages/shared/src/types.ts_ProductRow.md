# packages/shared/src/types.ts:ProductRow

Interface для товарной позиции сделки. Поля: ID, PRODUCT_ID, PRODUCT_NAME, PRICE, QUANTITY, DISCOUNT_SUM, TAX_RATE, SUM, MEASURE_NAME, SORT, IMAGE_BASE64?, IMAGE_URL?. Числовые поля (PRICE, QUANTITY, SUM и т.д.) типизированы как number. IMAGE_BASE64 и IMAGE_URL опциональны — заполняются только при fetchProductImages=true.
