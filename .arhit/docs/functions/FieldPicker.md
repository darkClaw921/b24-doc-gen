# FieldPicker

Three-tab CRM field picker used inside FormulaBuilder. Tabs: Сделка/Контакт/Компания. Loads all three field schemas in a single call via crmApi.allFields (GET /api/crm/fields, backend-cached 5 min per portal). Supports free-text search filtering over code or title. Clicking a field invokes onSelect(token, field, entity) with a namespaced token like DEAL.OPPORTUNITY. Shows field type + multiple/required markers.
