import { PrismaClient } from '@prisma/client';
import { redact } from '@wetriip/observability';

/**
 * Append-only audit ledger.
 *
 * Every privileged action lands here with a before/after pair, a reason and a
 * correlation id. There is deliberately no update and no delete: an audit log
 * you can edit is not an audit log.
 *
 * This is also the substrate for natural-language undo — "roll back what we did
 * this morning" is a query over this table plus a new inverse action, never a
 * mutation of history.
 */
export interface AuditInput {
  tenantId: string;
  actorType: 'USER' | 'AGENT' | 'SYSTEM' | 'CONNECTOR';
  actorId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  correlationId: string;
  ip?: string | null;
}

export class AuditLog {
  constructor(private readonly prisma: PrismaClient) {}

  async record(input: AuditInput): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        before: input.before == null ? undefined : (redact(input.before) as any),
        after: input.after == null ? undefined : (redact(input.after) as any),
        reason: input.reason ?? null,
        correlationId: input.correlationId,
        ip: input.ip ?? null,
      },
    });
  }

  /** Same-transaction variant so an action and its audit row cannot diverge. */
  async recordTx(tx: any, input: AuditInput): Promise<void> {
    await tx.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        before: input.before == null ? undefined : (redact(input.before) as any),
        after: input.after == null ? undefined : (redact(input.after) as any),
        reason: input.reason ?? null,
        correlationId: input.correlationId,
        ip: input.ip ?? null,
      },
    });
  }

  async list(tenantId: string, opts: { limit?: number; resourceType?: string; correlationId?: string } = {}) {
    const rows = await this.prisma.auditEvent.findMany({
      where: {
        tenantId,
        ...(opts.resourceType ? { resourceType: opts.resourceType } : {}),
        ...(opts.correlationId ? { correlationId: opts.correlationId } : {}),
      },
      orderBy: { id: 'desc' },
      take: Math.min(opts.limit ?? 100, 500),
    });
    return rows.map((r) => ({ ...r, id: r.id.toString() }));
  }
}
