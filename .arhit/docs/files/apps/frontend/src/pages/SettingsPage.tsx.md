# apps/frontend/src/pages/SettingsPage.tsx

Page Фазы 5 с управлением AppSettings. Три секции: 1) UF_CRM file field dropdown из settingsApi.dealFields с кнопкой Create через Dialog (XML_ID sanitization A-Z/0-9/_, POST settingsApi.createField); 2) Admin picker — debounced usersApi.search + checkbox выбор, текущие показаны списком с Trash (использует PortalUserDTO); 3) Save-bar с settingsApi.update({dealFieldBinding, adminUserIds}). saveMessage строка для success/error feedback. useDebouncedValue 300ms для поиска.
