# ManualFieldTag

TipTap inline atom-нода manualFieldTag для ручных полей шаблона. Атрибуты fieldKey/label/type/required/placeholder сериализуются в data-field-key/label/type/required/placeholder. parseHTML принимает span[data-field-key], renderHTML — янтарный pill '✎ {label}' (со * для обязательного). Команда insertManualFieldTag(attrs) и helper insertManualField(editor, attrs). Аналог FormulaTag, но значение заполняет пользователь при генерации, а не вычисляется.
