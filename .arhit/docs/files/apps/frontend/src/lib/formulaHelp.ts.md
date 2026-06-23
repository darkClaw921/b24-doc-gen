# apps/frontend/src/lib/formulaHelp.ts

Справочник метаданных функций и операторов формул. HELPER_DOCS (Record по имени: signature, summary, description, args[], examples[]) для if/concat/format/dateFormat/today/upper/lower/productSum/productCount/productGet/productImage. today(fmt?) — пресет текущей даты на момент генерации документа, формат как у dateFormat, по умолчанию dd.MM.yyyy. OPERATOR_DOCS — символ→описание. extractUsedHelpers(expression) парсит имена функций перед ( и возвращает HelperDoc[]. Один источник правды для FormulaBuilder (тултипы) и TemplateEditorPage (hover-подсказки).
