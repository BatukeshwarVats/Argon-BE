/**
 * Prisma client singleton.
 *
 * - One instance per process (avoids connection-pool exhaustion).
 * - The worker and the API each load this module once.
 */
import { PrismaClient } from '@prisma/client';
import { config } from '../../config';
import { logger } from '../../shared/logger';

export const prisma = new PrismaClient({
  log:
    config.NODE_ENV === 'development'
      ? [{ level: 'query', emit: 'event' }, 'warn', 'error']
      : ['warn', 'error'],
});

// Wire Prisma's query log into pino at trace level so it's off by default.
prisma.$on('query' as never, (e: { duration: number; query: string }) => {
  logger.trace({ ms: e.duration, query: e.query }, 'prisma.query');
});

export async function disconnectPrisma() {
  await prisma.$disconnect();
}
