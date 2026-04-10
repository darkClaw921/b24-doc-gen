# apps/backend/src/services/b24Client.ts:downloadFileAsBase64

Метод B24Client для скачивания файла по URL Bitrix24 и конвертации в base64 data URI. Добавляет ?auth=accessToken к URL для аутентификации. Определяет MIME тип из Content-Type ответа. Возвращает строку data:mime;base64,... или пустую строку при ошибке.
