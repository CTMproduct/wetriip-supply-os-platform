import { PrismaClient } from '@prisma/client';

export type Prisma = PrismaClient;

let singleton: PrismaClient | null = null;

/**
 * One client per process. Each service opens its own pool; sizing is per
 * service because their traffic shapes are not comparable — ari-ingestion is
 * write-bound and bursty, search is read-bound and steady.
 */
export function getPrisma(): PrismaClient {
  if (!singleton) {
    singleton = new PrismaClient({
      log: process.env.LOG_LEVEL === 'debug' ? ['query', 'warn', 'error'] : ['warn', 'error'],
    });
  }
  return singleton;
}

export async function disconnectPrisma(): Promise<void> {
  if (singleton) {
    await singleton.$disconnect();
    singleton = null;
  }
}
