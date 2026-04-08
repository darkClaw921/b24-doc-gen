# registerFormulaRoutes

Fastify route registrar for POST /api/formulas/validate and /api/formulas/evaluate. Validate wraps formulaEngine.validateExpression and returns {valid, error?, dependencies}. Evaluate optionally fetches deal context via two-stage batch (crm.deal.get + crm.deal.contact.items.get → crm.contact.get + crm.company.get) mirroring the routes/deal.ts data endpoint, supports inline context override from the request body, and returns {ok, value, raw, error?, dependencies}. Auth-gated by the global B24 middleware.
