# apps/frontend/src/lib/quickFields.ts

Чистые хелперы палитры 'Часто используемые поля' FormulaBuilder. QuickField {label,token}; константы QUICK_FIELDS_PAGE_SIZE=6, QUICK_FIELDS_MAX=20, ключ localStorage; DEFAULT_QUICK_FIELDS сид. loadRecentFields/saveRecentFields — localStorage с защитой от повреждённого JSON. mergeQuickFields — слияние истории с дефолтами (дедуп, кап). addRecentField — редьюсер: токен в начало, дедуп, кап. Покрыто quickFields.test.ts.
