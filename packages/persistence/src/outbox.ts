import { DomainEvent, EventType } from '@wetriip/contracts';
import type { OutboxStore } from '@wetriip/bus';
import { PrismaClient } from '@prisma/client';

/**
 * Transactional outbox.
 *
 * The rule that makes events trustworthy: an event row is written in the SAME
 * database transaction as the domain change it describes. Either both land or
 * neither does. Publishing from application code after a commit is where
 * "the booking exists but nobody was told" comes from.
 */
export class PrismaOutboxStore implements OutboxStore {
  constructor(private readonly prisma: PrismaClient) {}

  async enqueue(rows: Array<Omit<DomainEvent, 'id'>>): Promise<void> {
    await this.prisma.outboxEvent.createMany({
      data: rows.map((r) => ({
        tenantId: r.tenantId,
        type: r.type,
        payload: { partitionKey: r.partitionKey, version: r.version, data: r.payload } as any,
        correlationId: r.correlationId,
      })),
    });
  }

  /** Same-transaction variant. Callers inside a $transaction pass their tx. */
  async enqueueTx(tx: any, rows: Array<Omit<DomainEvent, 'id'>>): Promise<void> {
    await tx.outboxEvent.createMany({
      data: rows.map((r: Omit<DomainEvent, 'id'>) => ({
        tenantId: r.tenantId,
        type: r.type,
        payload: { partitionKey: r.partitionKey, version: r.version, data: r.payload } as any,
        correlationId: r.correlationId,
      })),
    });
  }

  async claimUnpublished(limit: number): Promise<Array<DomainEvent & { attempts: number }>> {
    const rows = await this.prisma.outboxEvent.findMany({
      where: { publishedAt: null, attempts: { lt: 10 } },
      orderBy: { id: 'asc' },
      take: limit,
    });
    return rows.map((r) => {
      const p = (r.payload ?? {}) as any;
      return {
        id: r.id.toString(),
        type: r.type as EventType,
        tenantId: r.tenantId,
        partitionKey: p.partitionKey ?? r.tenantId,
        payload: p.data,
        correlationId: r.correlationId,
        occurredAt: r.createdAt.toISOString(),
        version: p.version ?? 1,
        attempts: r.attempts,
      };
    });
  }

  async markPublished(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.prisma.outboxEvent.updateMany({
      where: { id: { in: ids.map((i) => BigInt(i)) } },
      data: { publishedAt: new Date() },
    });
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id: BigInt(id) },
      data: { attempts: { increment: 1 }, lastError: error.slice(0, 1000) },
    });
  }

  async backlog(): Promise<number> {
    return this.prisma.outboxEvent.count({ where: { publishedAt: null } });
  }
}
