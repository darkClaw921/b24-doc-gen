# apps/backend/src/services/b24Client.ts:getDealProductRows

Метод B24Client для получения товарных позиций сделки. Вызывает crm.deal.productrows.get с параметром id=dealId. Нормализует ответ через normalizeProductRow в ProductRow[]. Возвращает пустой массив если ответ не массив.
