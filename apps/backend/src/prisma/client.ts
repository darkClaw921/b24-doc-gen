import { PrismaClient } from '@prisma/client';

/**
 * Singleton PrismaClient instance shared across the backend.
 *
 * During development tsx/ts-node may re-instantiate modules on every
 * file change, which would leak database connections. We stash the
 * client on `globalThis` to reuse it across hot-reloads.
 */
declare global {
  // eslint-disable-next-line no-var
  var __prismaClient: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  globalThis.__prismaClient ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalThis.__prismaClient = prisma;
}
