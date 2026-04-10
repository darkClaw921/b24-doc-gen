# apps/backend/src/services/b24Client.ts:getProductImages

Метод B24Client для получения картинок товара каталога. Вызывает catalog.productImage.list с select=[id,name,productId,type,downloadUrl,detailUrl]. Требует OAuth scope catalog. Ошибки проглатываются (возвращает пустой массив) — scope может отсутствовать.
