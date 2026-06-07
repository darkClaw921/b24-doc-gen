# ManualFieldBuilder

Модалка конструктора ручного поля (shadcn Dialog). Inputs: label, fieldKey (авто-slug через generateTagKey с флагом keyDirty), select типа (text/textarea/number/date), чекбокс Обязательное, input placeholder. Поддержка EDIT-режима (initialValues) и проверки уникальности (existingKeys). На submit вызывает onInsert({fieldKey, label, type, required, placeholder}). Экспортирует ManualFieldBuilderResult.
