# apps/backend/src/services/dealData.ts

Сервис Фазы 5: getDealContext(client, dealId) — собирает FormulaContext {DEAL,CONTACT,COMPANY} двумя batch-вызовами Bitrix24 (deal+contacts, затем contact+company при наличии id). Нормализует мульти-значения PHONE/EMAIL/WEB/IM в скаляры через flattenEntity/flattenValue. Бросает DealDataError для случаев когда сделка не найдена. Используется routes/templates.ts (preview) и routes/generate.ts.
