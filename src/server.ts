/**
 * API process entrypoint.
 *
 * Worker runs in a separate process (src/worker.ts) so:
 *   - We can scale them independently (more API replicas vs. more workers).
 *   - A crash in image processing doesn't take HTTP down.
 */
import { buildApp } from './app';
import { config } from './config';
import { logger } from './shared/logger';
import { disconnectPrisma } from './infra/db/prisma';
import { closeQueue } from './infra/queue/queue';
import { closeEvents, startEventSubscriber } from './shared/events';

const app = buildApp();
startEventSubscriber();

const server = app.listen(config.PORT, () => {
  logger.info(
    { port: config.PORT, env: config.NODE_ENV },
    'argon-be API listening',
  );
});

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutdown.begin');
  server.close();
  await Promise.allSettled([closeQueue(), disconnectPrisma(), closeEvents()]);
  logger.info('shutdown.done');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandledRejection');
});
