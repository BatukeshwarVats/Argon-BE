/**
 * Cross-process status event bus.
 *
 * - The worker process publishes status changes to a Redis channel.
 * - The API process subscribes once on boot and re-broadcasts via an
 *   in-process EventEmitter to all open SSE connections.
 *
 * Why this shape? Each Express SSE handler shouldn't open its own Redis
 * subscriber — that'd be one Redis connection per HTTP client. Instead we
 * fan out a single Redis subscription to many local listeners.
 *
 * To scale horizontally past one API replica: nothing changes — every replica
 * subscribes to the same Redis channel and serves its own SSE clients.
 */
import { EventEmitter } from 'events';
import Redis from 'ioredis';
import type { ImageStatus } from '@prisma/client';
import type { RejectionReason } from './rejection-codes';
import { config } from '../config';
import { logger } from './logger';

export interface ImageStatusEvent {
  imageId: string;
  userId: string;
  status: ImageStatus;
  rejectionReasons?: RejectionReason[];
  at: string;
}

const CHANNEL = 'argon:image.status';

class TypedEmitter extends EventEmitter {
  onStatus(handler: (ev: ImageStatusEvent) => void) {
    this.on('image.status', handler);
    return () => this.off('image.status', handler);
  }
}

const localEmitter = new TypedEmitter();
localEmitter.setMaxListeners(0);

let publisher: Redis | null = null;
let subscriber: Redis | null = null;

function getPublisher(): Redis {
  if (!publisher) {
    publisher = new Redis({ host: config.REDIS_HOST, port: config.REDIS_PORT });
    publisher.on('error', (err) => logger.error({ err }, 'events.publisher.error'));
  }
  return publisher;
}

/**
 * Call once from the API process to start fanning Redis messages into the
 * local EventEmitter. Idempotent.
 */
export function startEventSubscriber(): void {
  if (subscriber) return;
  subscriber = new Redis({ host: config.REDIS_HOST, port: config.REDIS_PORT });
  subscriber.on('error', (err) => logger.error({ err }, 'events.subscriber.error'));
  subscriber.subscribe(CHANNEL, (err) => {
    if (err) logger.error({ err }, 'events.subscribe.failed');
    else logger.info({ channel: CHANNEL }, 'events.subscribed');
  });
  subscriber.on('message', (_chan, raw) => {
    try {
      const ev = JSON.parse(raw) as ImageStatusEvent;
      localEmitter.emit('image.status', ev);
    } catch (err) {
      logger.warn({ err, raw }, 'events.parse_failed');
    }
  });
}

/**
 * Publish a status change. Called from the worker.
 * Falls back to a local emit (same process) so single-process tests still work.
 */
export const eventBus = {
  emitStatus(ev: ImageStatusEvent) {
    localEmitter.emit('image.status', ev);
    getPublisher().publish(CHANNEL, JSON.stringify(ev)).catch((err) => {
      logger.warn({ err }, 'events.publish_failed');
    });
  },
  onStatus(handler: (ev: ImageStatusEvent) => void) {
    return localEmitter.onStatus(handler);
  },
};

export async function closeEvents(): Promise<void> {
  await Promise.allSettled([publisher?.quit(), subscriber?.quit()]);
  publisher = null;
  subscriber = null;
}
