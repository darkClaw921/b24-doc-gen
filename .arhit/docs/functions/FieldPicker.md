# FieldPicker

Tabbed picker полей CRM внутри FormulaBuilder. Вкладки: Сделка (DEAL), Контакт (CONTACT), Компания (COMPANY), Ответственный (ASSIGNED — поля ответственного пользователя сделки из user.fields), Товары (PRODUCT, статический список). Схемы DEAL/CONTACT/COMPANY/ASSIGNED грузятся из GET /api/crm/fields (crmApi.allFields), кешируются на бэкенде 5 мин. Клик по полю вызывает onSelect(token) с токеном вида ENTITY.CODE (например ASSIGNED.WORK_POSITION); для товаров — productGet(1, "CODE").
