import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { InMemoryBus, OutboxBus } from '@wetriip/bus';
import { AuditLog, PrismaIdempotencyStore, PrismaOutboxStore, disconnectPrisma, getPrisma } from '@wetriip/persistence';
import { Logger } from '@wetriip/observability';

export const PRISMA = 'PRISMA';
export const EVENT_BUS = 'EVENT_BUS';
export const OUTBOX_STORE = 'OUTBOX_STORE';
export const AUDIT_LOG = 'AUDIT_LOG';
export const IDEMPOTENCY = 'IDEMPOTENCY';
export const LOGGER = 'LOGGER';

/**
 * Shared infrastructure providers.
 *
 * `BUS_MODE=memory` swaps the outbox for an in-process bus. Tests and the
 * all-in-one host use it; production never should, because an in-process bus
 * loses events on restart and the outbox is what makes delivery survivable.
 */
@Global()
@Module({})
export class PlatformModule implements OnApplicationShutdown {
  static forService(service: string) {
    const prisma = getPrisma();
    const outboxStore = new PrismaOutboxStore(prisma);
    const log = new Logger(service);
    const bus =
      process.env.BUS_MODE === 'memory' ? new InMemoryBus(log) : new OutboxBus(outboxStore, log);

    return {
      module: PlatformModule,
      providers: [
        { provide: PRISMA, useValue: prisma },
        { provide: OUTBOX_STORE, useValue: outboxStore },
        { provide: EVENT_BUS, useValue: bus },
        { provide: AUDIT_LOG, useValue: new AuditLog(prisma) },
        { provide: IDEMPOTENCY, useValue: new PrismaIdempotencyStore(prisma, service) },
        { provide: LOGGER, useValue: log },
      ],
      exports: [PRISMA, OUTBOX_STORE, EVENT_BUS, AUDIT_LOG, IDEMPOTENCY, LOGGER],
    };
  }

  async onApplicationShutdown() {
    await disconnectPrisma();
  }
}
