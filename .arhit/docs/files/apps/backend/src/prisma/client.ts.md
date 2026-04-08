# apps/backend/src/prisma/client.ts

Singleton PrismaClient. Экспортирует переменную prisma (тип PrismaClient). Хранит инстанс на globalThis.__prismaClient в dev-режиме, чтобы tsx watch не создавал новые соединения к SQLite при каждом hot-reload. В production создаёт новый инстанс без кеша. Логирование: warn/error в dev, только error в production.
