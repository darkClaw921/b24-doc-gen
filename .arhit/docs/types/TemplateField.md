# TemplateField

Общий тип ручного поля шаблона (packages/shared) и модель Prisma. Поля: fieldKey, label, type (text/textarea/number/date), required, placeholder?, order. Заполняется пользователем при генерации, ссылается из contentHtml нодой manualFieldTag. Хранится в таблице TemplateField (unique templateId+fieldKey, onDelete Cascade).
