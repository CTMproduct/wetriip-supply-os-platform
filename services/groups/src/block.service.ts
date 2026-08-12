import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import {
  Bedding,
  DomainError,
  GroupBenefit,
  GroupBlockLine,
  SetGroupPolicySchema,
  UpsertGroupBlockSchema,
} from '@wetriip/contracts';
import { BlockConsumption, assertCan, blockCapacity } from '@wetriip/domain';
import { AuditLog } from '@wetriip/persistence';
import { AUDIT_LOG, PRISMA, RequestContext } from '@wetriip/service-kit';
import { toNumber } from './util';

/**
 * Group blocks and the policy that prices them.
 *
 * A block is DECLARED inventory, not observed inventory. The hotel is saying
 * "these rooms are held back for group business", which is a commercial
 * decision the channel manager knows nothing about — so it lives here and never
 * enters the ARI ledger. Rule 4 of the platform, applied to a new domain.
 */
@Injectable()
export class BlockService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
  ) {}

  private principal(ctx: RequestContext) {
    return {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
      role: ctx.role as any,
      permissions: ctx.permissions,
      propertyIds: ctx.propertyIds,
      status: ctx.status,
    };
  }

  async list(ctx: RequestContext, propertyId?: string) {
    assertCan(this.principal(ctx), 'groups.read');
    const blocks = await this.prisma.groupBlock.findMany({
      where: { tenantId: ctx.tenantId, ...(propertyId ? { propertyId } : {}) },
      include: { lines: true },
      orderBy: [{ fromDate: 'asc' }, { code: 'asc' }],
    });
    return Promise.all(blocks.map((b) => this.withCapacity(b)));
  }

  async get(ctx: RequestContext, blockId: string, excludeRequestId?: string) {
    assertCan(this.principal(ctx), 'groups.read');
    const block = await this.prisma.groupBlock.findFirst({
      where: { id: blockId, tenantId: ctx.tenantId },
      include: { lines: true },
    });
    if (!block) {
      throw new DomainError({ code: 'NOT_FOUND', message: 'Group block not found', owner: 'Groups' });
    }
    return this.withCapacity(block, excludeRequestId);
  }

  /**
   * Live availability, derived from the requests rather than stored on the
   * block. A counter that has to be maintained is a counter that drifts, and a
   * drifted group counter is a double-sold block.
   */
  async consumption(blockId: string, excludeRequestId?: string): Promise<BlockConsumption> {
    const rows = await this.prisma.groupRequest.findMany({
      where: {
        blockId,
        status: { in: ['OPEN', 'COUNTERED', 'ACCEPTED'] },
        // When re-checking capacity in order to ACCEPT a request, that request
        // is itself holding the rooms. Counting its own hold against it means
        // no group can ever be accepted once the block is tight — a bug that
        // hides completely while there is slack and appears the moment a
        // second group arrives.
        ...(excludeRequestId ? { NOT: { id: excludeRequestId } } : {}),
      },
      select: { rooms: true, status: true, expiresAt: true },
    });

    const committed: Partial<Record<Bedding, number>> = {};
    const held: Partial<Record<Bedding, number>> = {};
    const now = new Date();

    for (const r of rows) {
      // A lapsed offer holds nothing, whatever the sweeper has got round to.
      const live = r.status === 'ACCEPTED' || r.expiresAt > now;
      if (!live) continue;
      const bucket = r.status === 'ACCEPTED' ? committed : held;
      for (const line of (r.rooms as any[]) ?? []) {
        bucket[line.bedding as Bedding] = (bucket[line.bedding as Bedding] ?? 0) + line.rooms;
      }
    }
    return { committed, held };
  }

  private async withCapacity(block: any, excludeRequestId?: string) {
    const lines: GroupBlockLine[] = block.lines.map((l: any) => ({
      roomTypeId: l.roomTypeId,
      bedding: l.bedding,
      roomsTotal: l.roomsTotal,
      ratePerNight: toNumber(l.ratePerNight),
    }));
    const capacity = blockCapacity(
      lines,
      block.roomsCeiling,
      await this.consumption(block.id, excludeRequestId),
    );
    return {
      id: block.id,
      propertyId: block.propertyId,
      code: block.code,
      name: block.name,
      from: block.fromDate,
      to: block.toDate,
      currency: block.currency,
      roomsCeiling: block.roomsCeiling,
      releaseDays: block.releaseDays,
      minRooms: block.minRooms,
      status: block.status,
      notes: block.notes,
      lines,
      capacity,
      createdAt: block.createdAt.toISOString(),
    };
  }

  async upsert(ctx: RequestContext, input: unknown) {
    assertCan(this.principal(ctx), 'groups.write');
    const b = UpsertGroupBlockSchema.parse(input);
    assertCan(this.principal(ctx), 'groups.write', b.propertyId);

    const property = await this.prisma.property.findFirst({
      where: { id: b.propertyId, tenantId: ctx.tenantId },
      include: { roomTypes: true },
    });
    if (!property) {
      throw new DomainError({ code: 'NOT_FOUND', message: 'Property not found', owner: 'Groups' });
    }

    // A block that points at a room type from another hotel would look correct
    // in the UI and be unsellable in reality.
    for (const line of b.lines) {
      if (!property.roomTypes.some((rt) => rt.id === line.roomTypeId)) {
        throw new DomainError({
          code: 'VALIDATION',
          message: 'A block line references a room type that does not belong to this property',
          owner: 'Groups',
          details: { roomTypeId: line.roomTypeId },
        });
      }
    }

    const existing = await this.prisma.groupBlock.findFirst({
      where: { tenantId: ctx.tenantId, propertyId: b.propertyId, code: b.code },
      include: { lines: true },
    });

    // Shrinking a block below what is already sold is the one edit that turns
    // into an oversell, so it is refused with the number that blocks it.
    if (existing) {
      const cons = await this.consumption(existing.id);
      const committedTotal = Object.values(cons.committed).reduce<number>((a, n) => a + (n ?? 0), 0);
      if (b.roomsCeiling < committedTotal) {
        throw new DomainError({
          code: 'CONFLICT',
          message: `${committedTotal} rooms are already committed to accepted groups; the ceiling cannot drop to ${b.roomsCeiling}.`,
          owner: 'Groups',
          remediation: 'Cancel or renegotiate the accepted groups first.',
          details: { committedTotal, requested: b.roomsCeiling },
        });
      }
      for (const line of b.lines) {
        const already = cons.committed[line.bedding] ?? 0;
        if (line.roomsTotal < already) {
          throw new DomainError({
            code: 'CONFLICT',
            message: `${already} ${line.bedding} rooms are already committed; that line cannot drop to ${line.roomsTotal}.`,
            owner: 'Groups',
            details: { bedding: line.bedding, already },
          });
        }
      }
    }

    const saved = await this.prisma.$transaction(async (tx) => {
      const block = existing
        ? await tx.groupBlock.update({
            where: { id: existing.id },
            data: {
              name: b.name,
              fromDate: b.from,
              toDate: b.to,
              currency: b.currency,
              roomsCeiling: b.roomsCeiling,
              releaseDays: b.releaseDays,
              minRooms: b.minRooms,
              status: b.status,
              notes: b.notes,
            },
          })
        : await tx.groupBlock.create({
            data: {
              tenantId: ctx.tenantId,
              propertyId: b.propertyId,
              code: b.code,
              name: b.name,
              fromDate: b.from,
              toDate: b.to,
              currency: b.currency,
              roomsCeiling: b.roomsCeiling,
              releaseDays: b.releaseDays,
              minRooms: b.minRooms,
              status: b.status,
              notes: b.notes,
              createdBy: ctx.userId,
            },
          });

      // Lines are replaced wholesale: the payload is the full intended state,
      // so a line the hotel removed must actually disappear.
      await tx.groupBlockLine.deleteMany({ where: { blockId: block.id } });
      await tx.groupBlockLine.createMany({
        data: b.lines.map((l) => ({
          blockId: block.id,
          roomTypeId: l.roomTypeId,
          bedding: l.bedding,
          roomsTotal: l.roomsTotal,
          ratePerNight: l.ratePerNight,
        })),
      });

      return block;
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorType: 'USER',
      actorId: ctx.userId,
      action: existing ? 'group.block.updated' : 'group.block.created',
      resourceType: 'GroupBlock',
      resourceId: saved.id,
      before: existing
        ? { roomsCeiling: existing.roomsCeiling, status: existing.status, lines: existing.lines.length }
        : null,
      after: { roomsCeiling: b.roomsCeiling, status: b.status, lines: b.lines.length },
      correlationId: ctx.correlationId,
      ip: ctx.ip,
    });

    return this.get(ctx, saved.id);
  }

  /* ── Policy ────────────────────────────────────────────── */

  async getPolicy(ctx: RequestContext, propertyId: string) {
    assertCan(this.principal(ctx), 'groups.read');
    const row = await this.prisma.groupPolicy.findFirst({
      where: { propertyId, tenantId: ctx.tenantId },
    });
    if (!row) {
      // An unset policy is a real, meaningful state: this hotel has never told
      // us what it will accept. Returning defaults silently would let a bid be
      // measured against a floor nobody chose.
      return {
        propertyId,
        configured: false,
        minRoomsForGroup: 10,
        floorRatePerNight: null,
        floorCurrency: null,
        autoDeclineBelowFloor: false,
        responseWindowHours: 24,
        depositPct: 30,
        cancellationPolicy: null,
        benefits: [] as GroupBenefit[],
        notifyEmails: [] as string[],
        notifyWhatsapp: [] as string[],
      };
    }
    return {
      propertyId,
      configured: true,
      minRoomsForGroup: row.minRoomsForGroup,
      floorRatePerNight: toNumber(row.floorRatePerNight),
      floorCurrency: row.floorCurrency,
      autoDeclineBelowFloor: row.autoDeclineBelowFloor,
      responseWindowHours: row.responseWindowHours,
      depositPct: toNumber(row.depositPct) ?? 30,
      cancellationPolicy: row.cancellationPolicy,
      benefits: (row.benefits as unknown as GroupBenefit[]) ?? [],
      notifyEmails: row.notifyEmails,
      notifyWhatsapp: row.notifyWhatsapp,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async setPolicy(ctx: RequestContext, input: unknown) {
    assertCan(this.principal(ctx), 'groups.write');
    const p = SetGroupPolicySchema.parse(input);
    assertCan(this.principal(ctx), 'groups.write', p.propertyId);

    if (p.floorRatePerNight != null && !p.floorCurrency) {
      throw new DomainError({
        code: 'VALIDATION',
        message: 'A floor rate without a currency cannot be compared to anything.',
        owner: 'Groups',
        remediation: 'State the currency the floor is expressed in.',
      });
    }

    const before = await this.prisma.groupPolicy.findFirst({
      where: { propertyId: p.propertyId, tenantId: ctx.tenantId },
    });

    const row = await this.prisma.groupPolicy.upsert({
      where: { propertyId: p.propertyId },
      create: {
        tenantId: ctx.tenantId,
        propertyId: p.propertyId,
        minRoomsForGroup: p.minRoomsForGroup,
        floorRatePerNight: p.floorRatePerNight,
        floorCurrency: p.floorCurrency,
        autoDeclineBelowFloor: p.autoDeclineBelowFloor,
        responseWindowHours: p.responseWindowHours,
        depositPct: p.depositPct,
        cancellationPolicy: p.cancellationPolicy,
        benefits: p.benefits as any,
        notifyEmails: p.notifyEmails,
        notifyWhatsapp: p.notifyWhatsapp,
        updatedBy: ctx.userId,
      },
      update: {
        minRoomsForGroup: p.minRoomsForGroup,
        floorRatePerNight: p.floorRatePerNight,
        floorCurrency: p.floorCurrency,
        autoDeclineBelowFloor: p.autoDeclineBelowFloor,
        responseWindowHours: p.responseWindowHours,
        depositPct: p.depositPct,
        cancellationPolicy: p.cancellationPolicy,
        benefits: p.benefits as any,
        notifyEmails: p.notifyEmails,
        notifyWhatsapp: p.notifyWhatsapp,
        updatedBy: ctx.userId,
      },
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorType: 'USER',
      actorId: ctx.userId,
      action: 'group.policy.updated',
      resourceType: 'GroupPolicy',
      resourceId: row.id,
      before: before
        ? { floorRatePerNight: toNumber(before.floorRatePerNight), benefits: before.benefits }
        : null,
      after: { floorRatePerNight: p.floorRatePerNight, benefits: p.benefits },
      correlationId: ctx.correlationId,
      ip: ctx.ip,
    });

    return this.getPolicy(ctx, p.propertyId);
  }
}
