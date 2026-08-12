import { randomUUID } from 'node:crypto';
import { DomainEvent, EventType } from '@wetriip/contracts';
import { Logger } from '@wetriip/observability';

/**
 * Event bus abstraction.
 *
 * Services never call each other to announce that something happened; they
 * publish. The transport is swappable because the guarantee is not:
 * at-least-once delivery, ordered within a partition key.
 *
 * Two implementations ship here:
 *  · OutboxBus     — the production path. The domain change and its event
 *                    commit in the SAME transaction, then a relay publishes.
 *                    This is the only way an event cannot be lost or invented.
 *  · InMemoryBus   — local dev, tests and the all-in-one host.
 *
 * A Kafka/Redpanda implementation slots in behind `publishBatch` without any
 * service knowing.
 */

export type EventHandler<T = unknown> = (event: DomainEvent<T>) => Promise<void> | void;

export interface EventBus {
  publish<T>(
    type: EventType,
    payload: T,
    meta: { tenantId: string; partitionKey: string; correlationId: string; version?: number },
  ): Promise<void>;
  subscribe<T>(type: EventType | '*', handler: EventHandler<T>): void;
  /** Drain in-flight work. Tests depend on this; so does graceful shutdown. */
  flush(): Promise<void>;
}

export class InMemoryBus implements EventBus {
  private handlers = new Map<string, EventHandler[]>();
  private inFlight: Promise<unknown>[] = [];
  private readonly log: Logger;

  constructor(log?: Logger) {
    this.log = log ?? new Logger('bus');
  }

  subscribe<T>(type: EventType | '*', handler: EventHandler<T>): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler as EventHandler);
    this.handlers.set(type, list);
  }

  async publish<T>(
    type: EventType,
    payload: T,
    meta: { tenantId: string; partitionKey: string; correlationId: string; version?: number },
  ): Promise<void> {
    const event: DomainEvent<T> = {
      id: `evt_${randomUUID()}`,
      type,
      tenantId: meta.tenantId,
      partitionKey: meta.partitionKey,
      payload,
      correlationId: meta.correlationId,
      occurredAt: new Date().toISOString(),
      version: meta.version ?? 1,
    };

    const handlers = [...(this.handlers.get(type) ?? []), ...(this.handlers.get('*') ?? [])];
    for (const h of handlers) {
      // A failing subscriber must not fail the publisher. In production the
      // outbox relay retries; here we record and move on.
      const p = Promise.resolve()
        .then(() => h(event as DomainEvent))
        .catch((err) =>
          this.log.error('event handler failed', {
            type,
            correlationId: meta.correlationId,
            error: String(err),
          }),
        );
      this.inFlight.push(p);
    }
  }

  async flush(): Promise<void> {
    while (this.inFlight.length) {
      const batch = this.inFlight;
      this.inFlight = [];
      await Promise.all(batch);
    }
  }
}

/**
 * Storage contract for the transactional outbox. Implemented in
 * @wetriip/persistence against Postgres; kept as an interface so the bus never
 * imports Prisma.
 */
export interface OutboxStore {
  enqueue(rows: Array<Omit<DomainEvent, 'id'>>): Promise<void>;
  claimUnpublished(limit: number): Promise<Array<DomainEvent & { attempts: number }>>;
  markPublished(ids: string[]): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
}

export class OutboxBus implements EventBus {
  private readonly inner: InMemoryBus;

  constructor(
    private readonly store: OutboxStore,
    private readonly log = new Logger('outbox-bus'),
  ) {
    this.inner = new InMemoryBus(log);
  }

  subscribe<T>(type: EventType | '*', handler: EventHandler<T>): void {
    this.inner.subscribe(type, handler);
  }

  async publish<T>(
    type: EventType,
    payload: T,
    meta: { tenantId: string; partitionKey: string; correlationId: string; version?: number },
  ): Promise<void> {
    await this.store.enqueue([
      {
        type,
        tenantId: meta.tenantId,
        partitionKey: meta.partitionKey,
        payload,
        correlationId: meta.correlationId,
        occurredAt: new Date().toISOString(),
        version: meta.version ?? 1,
      },
    ]);
  }

  /** Relay loop: read committed events and deliver them. Runs on a timer in
   *  each service that hosts subscribers. */
  async relayOnce(batchSize = 100): Promise<number> {
    const rows = await this.store.claimUnpublished(batchSize);
    if (rows.length === 0) return 0;
    const delivered: string[] = [];
    for (const row of rows) {
      try {
        await this.inner.publish(row.type, row.payload, {
          tenantId: row.tenantId,
          partitionKey: row.partitionKey,
          correlationId: row.correlationId,
          version: row.version,
        });
        await this.inner.flush();
        delivered.push(row.id);
      } catch (err) {
        await this.store.markFailed(row.id, String(err));
        this.log.error('outbox delivery failed', { id: row.id, error: String(err) });
      }
    }
    if (delivered.length) await this.store.markPublished(delivered);
    return delivered.length;
  }

  async flush(): Promise<void> {
    await this.inner.flush();
  }
}

/**
 * Ordered dispatcher. Events sharing a partition key are processed strictly in
 * sequence; different keys run in parallel. This is what preserves per-cell ARI
 * ordering without serializing the whole fleet.
 */
export class PartitionedDispatcher {
  private chains = new Map<string, Promise<void>>();

  constructor(private readonly maxKeys = 10_000) {}

  submit(partitionKey: string, task: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(partitionKey) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.chains.set(partitionKey, next);
    next.finally(() => {
      if (this.chains.get(partitionKey) === next) this.chains.delete(partitionKey);
    });
    if (this.chains.size > this.maxKeys) {
      // Unbounded key growth is a memory leak in disguise; drop the oldest
      // completed chain rather than accumulate.
      const first = this.chains.keys().next().value;
      if (first) this.chains.delete(first);
    }
    return next;
  }

  async drain(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }
}
