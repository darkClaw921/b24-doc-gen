# SelectOptionsEditor

Переиспользуемый controlled-редактор вариантов списочного поля (frontend). Вынесен из ManualFieldBuilder, используется также в FieldPresetsSettings. Содержит: select режима подстановки (valueMode direct/mapped, скрывается showModeSelector=false), список options[{label,value}] с add/remove/inline-edit, блок массового ввода. Экспортирует parseBulkOptions(text, splitValue). Props: valueMode/onValueModeChange, options/onOptionsChange, showModeSelector?.
