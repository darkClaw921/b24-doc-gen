import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Vite configuration for the b24-doc-gen frontend.
// - Runs on port 5173 by default (configurable via VITE env).
// - Proxies /api calls to the backend at :3001 during development.
// - Exposes the `@` alias to `src` for shadcn/ui + local imports.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@b24-doc-gen/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    host: true,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});
