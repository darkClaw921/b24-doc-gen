import 'dotenv/config';
// Force IPv4 resolution first. Node 17+ defaults to "verbatim" DNS
// ordering, which makes undici's fetch try AAAA (IPv6) before A (IPv4).
// On many networks the IPv6 attempt hangs ~10s and crashes outbound
// requests with a generic "fetch failed" — this bites Bitrix24 REST
// calls intermittently. Setting ipv4first eliminates the stall.
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import Fastify, { type FastifyInstance, type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import qs from 'qs';
import multipart from '@fastify/multipart';
import sensible from '@fastify/sensible';
import fastifyStatic from '@fastify/static';
import httpProxy from '@fastify/http-proxy';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { registerHealthRoute } from './routes/health.js';
import { registerDealRoutes } from './routes/deal.js';
import { registerUsersRoutes } from './routes/users.js';
import { registerInstallRoutes } from './routes/install.js';
import { registerThemeRoutes } from './routes/themes.js';
import { registerTemplateRoutes } from './routes/templates.js';
import { registerFormulaRoutes } from './routes/formulas.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerGenerateRoutes } from './routes/generate.js';
import { registerMeRoutes } from './routes/me.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerWebhookRunRoute } from './routes/webhookRun.js';
import { registerAuthMiddleware } from './middleware/auth.js';

/**
 * Build a Fastify instance with all plugins, middleware and routes
 * registered. Kept as a factory so integration tests can spin up
 * their own instance.
 */
export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport:
        process.env.NODE_ENV === 'production'
          ? undefined
          : {
              target: 'pino-pretty',
              options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
            },
    },
  });

  const isDev = process.env.NODE_ENV !== 'production';
  const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:5173';

  // CORS — only needed in dev (cross-origin Vite dev server).
  // In prod the SPA is served from this same origin.
  const corsOrigins: string[] = isDev
    ? [
        'http://localhost:5173',
        'http://localhost:3001',
        frontendUrl,
        ...(process.env.PUBLIC_URL ? [process.env.PUBLIC_URL] : []),
      ].filter((v, i, a) => a.indexOf(v) === i)
    : [];

  await app.register(cors, {
    origin: isDev ? corsOrigins : false,
    credentials: true,
  });

  // Bitrix24 sends POST events with Content-Type:
  // application/x-www-form-urlencoded. Three distinct paths care:
  //   1. Install / open placement POSTs hit the SPA (`POST /`) and never
  //      read the body — they only care about the query params.
  //   2. Outgoing webhook robot POSTs hit `/api/webhook/run/:token` with
  //      a nested payload (`auth[access_token]=…&document_id[2]=DEAL_123`).
  //   3. Future bizproc handler POSTs use the same nested-bracket format.
  // @fastify/formbody wires in a proper parser; we pass `qs.parse` so
  // nested keys like `auth[access_token]` and indexed arrays like
  // `document_id[2]` are deserialised into real objects/arrays.
  await app.register(formbody, {
    parser: (str) => qs.parse(str),
  });

  // Multipart uploads (.docx template files).
  await app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024 },
  });

  // Adds app.httpErrors helpers (badRequest, unauthorized, etc).
  await app.register(sensible);

  // Global B24 auth middleware — gates every /api/* request.
  registerAuthMiddleware(app);

  // ── API routes (registered first — take priority over the frontend proxy) ──
  await app.register(registerHealthRoute);
  await app.register(registerDealRoutes);
  await app.register(registerUsersRoutes);
  await app.register(registerInstallRoutes);
  await app.register(registerThemeRoutes);
  await app.register(registerTemplateRoutes);
  await app.register(registerFormulaRoutes);
  await app.register(registerSettingsRoutes);
  await app.register(registerGenerateRoutes);
  await app.register(registerMeRoutes);
  await app.register(registerWebhookRoutes);
  await app.register(registerWebhookRunRoute);

  // ── Frontend serving (registered LAST so /api/* routes always win) ──
  const frontendDist = path.resolve(__dirname, '../../../frontend/dist');

  if (!isDev && existsSync(frontendDist)) {
    // Production: serve the compiled SPA from frontend/dist/.
    await app.register(fastifyStatic, {
      root: frontendDist,
      prefix: '/',
      wildcard: false,
    });
    // SPA fallback — unmatched routes serve index.html for React Router.
    app.setNotFoundHandler((_request, reply) => {
      void reply.sendFile('index.html');
    });
  } else if (isDev) {
    // Development: transparently reverse-proxy all non-/api traffic to Vite.
    //
    // WHY proxy instead of redirect:
    //   Bitrix24 communicates with the iframe via window.postMessage and
    //   validates the message origin against the registered app URL (ngrok).
    //   A 302 redirect would change the iframe origin → ngrok becomes
    //   localhost:5173, breaking the B24 SDK handshake.
    //   A transparent proxy keeps the ngrok origin intact throughout.
    const vitePort = process.env.FRONTEND_PORT ?? '5173';
    const viteOrigin = `http://localhost:${vitePort}`;

    // Bitrix24 opens the app via POST (with form-urlencoded body containing
    // DOMAIN/APP_SID/etc). Vite dev server only responds to GET on HTML
    // routes — POST returns 404. Handle these POSTs by fetching the
    // index.html from Vite over GET and returning it as-is.
    // The query string is preserved automatically (it's part of the URL).
    const handleSpaPost = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const url = `${viteOrigin}${req.url}`;
      try {
        const upstream = await fetch(url, { method: 'GET' });
        const body = await upstream.text();
        reply
          .code(upstream.status)
          .header('content-type', upstream.headers.get('content-type') ?? 'text/html; charset=utf-8')
          .send(body);
      } catch (err) {
        req.log.error({ err }, 'failed to proxy POST to Vite');
        reply
          .code(502)
          .send({ error: { code: 'BAD_GATEWAY', message: 'Vite dev server unreachable' } });
      }
    };

    // Catch POST on the root and any other non-/api POST that Bitrix24
    // might emit (placement handlers, install events).
    app.post('/', handleSpaPost);

    await app.register(httpProxy, {
      upstream: viteOrigin,
      prefix: '/',
      rewritePrefix: '/',
      http2: false,
      // Forward Vite HMR WebSocket upgrades transparently.
      websocket: true,
      // Exclude OPTIONS (CORS) and POST (handled above for SPA bootstrap).
      httpMethods: ['DELETE', 'GET', 'HEAD', 'PATCH', 'PUT'],
    });
  }

  // ── Centralized error handler ──
  app.setErrorHandler(async (err: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const statusCode = typeof err.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : 500;

    if (statusCode >= 500) {
      request.log.error({ err, url: request.url }, 'unhandled error');
    } else {
      request.log.warn(
        { err: { message: err.message, code: err.code, statusCode }, url: request.url },
        'request failed',
      );
    }

    const code =
      typeof err.code === 'string' && err.code.length > 0 ? err.code : `HTTP_${statusCode}`;

    const isProd = process.env.NODE_ENV === 'production';
    const payload: { error: { code: string; message: string; details?: unknown } } = {
      error: { code, message: err.message || 'Internal Server Error' },
    };

    const validation = (err as { validation?: unknown }).validation;
    if (validation) payload.error.details = validation;
    if (!isProd && statusCode >= 500 && err.stack) payload.error.details = { stack: err.stack };

    return reply.status(statusCode).send(payload);
  });

  return app;
}

/**
 * Process entry point. Starts the server on BACKEND_PORT (default 3001).
 */
async function start(): Promise<void> {
  const app = await buildServer();
  const port = Number(process.env.BACKEND_PORT ?? 3001);
  const host = process.env.BACKEND_HOST ?? '0.0.0.0';

  try {
    await app.listen({ port, host });
    app.log.info(`b24-doc-gen backend listening on http://${host}:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  void start();
}
