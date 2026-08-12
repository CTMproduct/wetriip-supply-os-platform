import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { newCorrelationId } from '@wetriip/contracts';
import { Logger } from '@wetriip/observability';
import { LOGGER, PRISMA, RequestContext, systemContext } from '@wetriip/service-kit';
import { ConnectionService } from './connection.service';

/**
 * Pull scheduler.
 *
 * Two things keep this from becoming the classic scheduled-job outage:
 *
 *  · a LEASE per connection, so overlapping runs cannot both advance the same
 *    checkpoint (the failure mode where two workers each think they synced)
 *  · one connection failing never aborts the loop for the others
 *
 * The lease is held in the connection's checkpoint column with an expiry, so it
 * survives a process restart without needing a separate coordination service.
 */
@Injectable()
export class PullScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly log: Logger,
    private readonly connections: ConnectionService,
  ) {}

  onApplicationBootstrap() {
    if (process.env.CONNECTIVITY_PULL_ENABLED !== 'true') {
      this.log.info('pull scheduler disabled');
      return;
    }
    const intervalMs = Number(process.env.CONNECTIVITY_PULL_INTERVAL_MS ?? 300_000);
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.log.info('pull scheduler started', { intervalMs });
  }

  async tick(): Promise<{ attempted: number; succeeded: number; failed: number }> {
    if (this.running) return { attempted: 0, succeeded: 0, failed: 0 };
    this.running = true;
    let attempted = 0;
    let succeeded = 0;
    let failed = 0;

    try {
      const conns = await this.prisma.connection.findMany({
        where: { status: { in: ['ACTIVE', 'PENDING'] }, mode: { in: ['PULL', 'BOTH'] } },
      });

      for (const conn of conns) {
        const lease = (conn.checkpoint as any)?.lease;
        if (lease && new Date(lease).getTime() > Date.now()) continue;

        const claimed = await this.claim(conn.id, conn.checkpoint);
        if (!claimed) continue;

        attempted += 1;
        const ctx: RequestContext = systemContext({
          tenantId: conn.tenantId,
          actor: 'pull-scheduler',
          correlationId: newCorrelationId(),
        });

        try {
          await this.connections.pull(ctx, conn.id);
          succeeded += 1;
        } catch (err) {
          failed += 1;
          this.log.warn('scheduled pull failed', {
            connectionId: conn.id,
            correlationId: ctx.correlationId,
            error: String(err),
          });
          await this.prisma.connection
            .update({ where: { id: conn.id }, data: { status: 'ERROR' } })
            .catch(() => undefined);
        }
      }
    } finally {
      this.running = false;
    }
    return { attempted, succeeded, failed };
  }

  /** Conditional update: only the worker whose write lands gets the lease. */
  private async claim(connectionId: string, checkpoint: unknown): Promise<boolean> {
    const leaseUntil = new Date(Date.now() + 10 * 60_000).toISOString();
    const res = await this.prisma.connection.updateMany({
      where: {
        id: connectionId,
        OR: [{ checkpoint: { equals: checkpoint as any } }, { checkpoint: { equals: null as any } }],
      },
      data: { checkpoint: { ...((checkpoint as any) ?? {}), lease: leaseUntil } as any },
    });
    return res.count === 1;
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }
}
