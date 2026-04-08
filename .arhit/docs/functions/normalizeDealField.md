# normalizeDealField

Хелпер B24Client. Преобразует сырое поле из crm.deal.fields/crm.contact.fields/crm.company.fields в DealField DTO. Параметры: code (имя поля), meta (RawDealField), userFieldLabel (опциональная подпись из crm.*.userfield.list для UF_CRM_*). Логика заголовка: userFieldLabel имеет приоритет над meta.title/formLabel/listLabel/filterLabel — потому что для UF_CRM_* полей crm.*.fields возвращает в title только технический FIELD_NAME, а человекочитаемое название лежит в EDIT_FORM_LABEL userfield.list. Fallback — сам code.
