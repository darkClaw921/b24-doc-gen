# normalizeUserField

Приватный хелпер b24Client: приводит запись user.userfield.list (UF_USR_* поле пользователя) к DealField. code=FIELD_NAME, title=EDIT_FORM_LABEL/LIST_COLUMN_LABEL/LIST_FILTER_LABEL (через pickLocalizedLabel) либо FIELD_NAME, type=USER_TYPE_ID, isRequired=MANDATORY==='Y', isUserField=true, isMultiple=MULTIPLE==='Y', items из LIST [{ID,VALUE}].
