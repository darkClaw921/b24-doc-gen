# getDealContext

dealData.getDealContext: собирает FormulaContext {DEAL,CONTACT,COMPANY,ASSIGNED,PRODUCTS} двумя batch-запросами. Stage1: crm.deal.get + crm.deal.contact.items.get (+productrows). Stage2: crm.contact.get + crm.company.get + user.get (по ASSIGNED_BY_ID сделки) — ответственный берётся как users[0]. flattenEntity нормализует мультиполя. Используется generationPipeline и preview.
