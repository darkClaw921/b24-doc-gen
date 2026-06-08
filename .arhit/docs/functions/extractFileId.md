# extractFileId

Достаёт числовой file id из одной записи множественного файлового поля. Обрабатывает документированную форму-объект {id,url,urlMachine}, а также легаси-варианты: скалярный id (number/string) и {ID|fileId|FILE_ID}. Возвращает number или null. Используется resolveExistingFileRefs.
