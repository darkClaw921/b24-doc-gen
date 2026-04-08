import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { initB24 } from './lib/b24';
import './index.css';

/**
 * Application entry point.
 *
 * Order of operations:
 *  1. Try to initialize the Bitrix24 SDK (`initializeB24Frame`). When
 *     the page is opened inside a portal iframe this resolves quickly
 *     and provides the auth payload + placement info.
 *  2. Mount the React tree (whether or not the SDK was available).
 *     Components read `isB24Available()` to decide between the real
 *     UI and an "open me from Bitrix24" stub.
 *
 * We deliberately do not block forever waiting for the SDK — when the
 * app is opened in a regular browser tab, `initB24()` will reject
 * after a few seconds and we still want to render the fallback UI.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

const root = ReactDOM.createRoot(rootElement);

function render(): void {
  root.render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </React.StrictMode>,
  );
}

initB24()
  .then(() => {
    // SDK is ready — components can now use getB24Auth(), getCurrentDealId(), etc.
    render();
  })
  .catch((err: unknown) => {
    // Outside of a Bitrix24 iframe (or behind a network error). Render
    // the app anyway so the fallback UI in PlacementGuard takes over.
    // eslint-disable-next-line no-console
    console.warn('Bitrix24 SDK failed to initialize:', err);
    render();
  });
