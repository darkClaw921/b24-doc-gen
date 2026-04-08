# apps/frontend/src/main.tsx

Точка входа фронтенд-SPA. Создаёт QueryClient (react-query) с refetchOnWindowFocus: false и retry: 1. Оборачивает App в QueryClientProvider + BrowserRouter и монтирует в #root через ReactDOM.createRoot. Использует React.StrictMode.
