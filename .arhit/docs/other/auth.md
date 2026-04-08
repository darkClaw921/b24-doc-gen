# auth

Fastify preHandler middleware that gates /api/* routes. Reads X-B24-Access-Token / X-B24-Member-Id / X-B24-Domain headers (or body.auth), validates shape and Bitrix24 domain, optionally verifies HMAC signature with B24_APP_SECRET, populates request.b24Auth = {userId, domain, accessToken, memberId}. Public allow-list: /health, /api/health. Throws app.httpErrors.unauthorized on failure.
