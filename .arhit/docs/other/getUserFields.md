# getUserFields

Метод B24Client: схема полей ответственного пользователя (ASSIGNED.*) для FieldPicker. Мержит два источника: user.fields (стандартные поля код→метка, type:'string') и user.userfield.list (пользовательские UF_USR_* поля с реальным USER_TYPE_ID, MULTIPLE/MANDATORY и LIST вариантами для enumeration). UF-вызов best-effort (ошибки/отсутствие scope user.userfield → пустой список, стандартные поля всё равно возвращаются). Стандартные UF-коды из user.fields заменяются богатой UF-метаинформацией. Нормализация UF — normalizeUserField.
