# deal

Backend deal proxy routes. GET /api/deal/:id/fields returns crm.deal.fields normalized to DealField[], cached per portal in TTLCache (5 minutes). GET /api/deal/:id/data executes two-stage callBatch: stage 1 fetches crm.deal.get + crm.deal.contact.items.get; stage 2 fetches crm.contact.get (primary contact) + crm.company.get. Returns {deal, contact, company}. invalidateDealFieldsCache(portal?) helper for cache busting after UF_CRM creation.
