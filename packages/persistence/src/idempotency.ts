import { PrismaClient } from '@prisma/client';
import type { IdempotencyStore } from '@wetriip/domain';

/**
 * Durable idempotency, enforced by a primary key rather than by a lock.
 *
 * The audit rates a duplicate booking from a non-idempotent retry as P0. The
 * defence has to survive a process restart, so it lives in the database: the
 * caller's key is inserted first, and the uniqueness of that insert is what
 * makes the second attempt lose. No advisory locks, no distributed
 * coordination, nothing to get out of sync.
 *
 * Booking and AriEvent carry their own unique idempotencyKey columns; this
 * store covers the paths without a natural home — agent executions, supplier
 * callbacks, reconciliation jobs.
 */
export class PrismaIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly scope = 'default',
  ) {}

  async get(key: string): Promise<{ status: 'IN_PROGRESS' | 'COMPLETED'; result?: unknown } | null> {
    const row = await this.prisma.idempotencyRecord.findUnique({ where: { key } });
    if (!row) return null;
    if (row.expiresAt.getTime() < Date.now()) {
      await this.prisma.idempotencyRecord.delete({ where: { key } }).catch(() => undefined);
      return null;
    }
    return { status: row.status as 'IN_PROGRESS' | 'COMPLETED', result: row.result ?? undefined };
  }

  /** True when this caller won the race and owns the operation. */
  async begin(key: string, ttlSeconds: number): Promise<boolean> {
    try {
      await this.prisma.idempotencyRecord.create({
        data: {
          key,
          scope: this.scope,
          status: 'IN_PROGRESS',
          expiresAt: new Date(Date.now() + ttlSeconds * 1000),
        },
      });
      return true;
    } catch {
      // Unique violation: someone else is already handling this key. That is
      // the whole point — we lose, and we do NOT retry the side effect.
      return false;
    }
  }

  async complete(key: string, result: unknown): Promise<void> {
    await this.prisma.idempotencyRecord.upsert({
      where: { key },
      create: {
        key,
        scope: this.scope,
        status: 'COMPLETED',
        result: result as any,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      update: { status: 'COMPLETED', result: result as any },
    });
  }

  /** Only for operations that failed BEFORE producing any external effect.
   *  Releasing after a supplier call is how duplicates are born. */
  async release(key: string): Promise<void> {
    await this.prisma.idempotencyRecord.deleteMany({ where: { key, status: 'IN_PROGRESS' } });
  }
}
