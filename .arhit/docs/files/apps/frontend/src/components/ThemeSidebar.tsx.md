# apps/frontend/src/components/ThemeSidebar.tsx

Левый сайдбар тем. Загружает список через TanStack Query (queryKey: ['themes']) → themesApi.list. Кнопка '+' открывает Dialog (создание); каждая тема имеет DropdownMenu с пунктами Переименовать/Удалить. Создание/переименование через useMutation + invalidate ['themes']. Удаление: window.confirm перед вызовом, при 409 (есть шаблоны) — inline-баннер. Контролируемый выбор: prop selectedThemeId + onSelect(themeId | null). После удаления выбранной темы вызывает onSelect(null). Использует shadcn/ui компоненты Button, Input, Dialog, DropdownMenu.
