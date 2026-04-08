# apps/backend/src/routes/health.ts

Регистрирует GET /health endpoint на Fastify-инстансе. Используется для health-check в development и container orchestration. Возвращает {status: 'ok', service: 'b24-doc-gen-backend', uptime: process.uptime(), timestamp: new Date().toISOString()}. Экспортирует registerHealthRoute(app: FastifyInstance): Promise<void>.
