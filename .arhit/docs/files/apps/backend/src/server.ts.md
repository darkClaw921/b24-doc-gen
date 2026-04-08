# apps/backend/src/server.ts

Fastify server factory buildServer(). Forces dns.setDefaultResultOrder('ipv4first') at module load to avoid the Node 17+ undici fetch IPv6 stall that causes 'fetch failed' on outbound Bitrix24 calls. Registers logger (pino-pretty in dev), CORS (dev only — Vite cross-origin), multipart, sensible, fastifyStatic for built SPA, http-proxy to Vite in dev, auth middleware, then all route modules: health, deal, users, install, themes, templates, formulas, settings, generate, me. Centralized error handler wraps everything in {error: {code, message, details?}}.
