# packages/shared/src/types.ts#ProductRow

Интерфейс товарной позиции сделки. Поля: ID, PRODUCT_ID, PRODUCT_NAME, PRICE, QUANTITY, DISCOUNT_SUM, TAX_RATE, SUM, MEASURE_NAME, SORT. Поля изображений (заполняются при fetchProductImages=true): PREVIEW_PICTURE_BASE64/URL (картинка анонса), DETAIL_PICTURE_BASE64/URL (детальная картинка), MORE_PHOTO_BASE64[]/MORE_PHOTO_URLS[] (массив доп. фото, до 10 шт). Fallback-логика при выборе картинки: preview → detail → more_photo[0].
