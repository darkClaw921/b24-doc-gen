# apps/backend/src/routes/install.ts

Install/placement routes. GET /api/install/status — проверка установки. POST /api/install — upsert AppSettings с adminUserIds и dealFieldBinding, сохранение OAuth-токенов. POST /api/install/sync-oauth — обновление токенов при каждом открытии. POST /api/install/register-placements — регистрация CRM_DEAL_DETAIL_TAB через placement.bind. GET /api/placements — список зарегистрированных мест встройки через placement.get. DELETE /api/placements — удаление места встройки через placement.unbind (принимает placement и handler в body).
