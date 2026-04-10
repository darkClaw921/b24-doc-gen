# apps/backend/src/routes/deal.ts::GET /api/crm/product-fields

Статический эндпоинт, возвращающий список полей товарных позиций сделки. Поля захардкожены: PRODUCT_NAME (string), PRICE (double), QUANTITY (double), DISCOUNT_SUM (double), TAX_RATE (double), SUM (double), MEASURE_NAME (string). Не требует дополнительных API-вызовов к Bitrix24. Формат ответа: { fields: CrmFieldDTO[] }.
