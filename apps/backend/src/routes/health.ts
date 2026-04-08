import type { FastifyInstance } from 'fastify';

/**
 * Registers the GET /health endpoint.
 *
 * Used by local development and container orchestration to check that
 * the Fastify instance is up. Returns a minimal JSON payload with the
 * service status and uptime in seconds.
 */
export async function registerHealthRoute(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => {
    return {
      status: 'ok',
      service: 'b24-doc-gen-backend',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  });
}
