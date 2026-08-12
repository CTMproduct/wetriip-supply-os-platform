import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { EventBus } from '@wetriip/bus';
import { DomainError, MappingResolver, ResolvedMapping } from '@wetriip/contracts';
import { AuditLog } from '@wetriip/persistence';
import { AUDIT_LOG, EVENT_BUS, PRISMA, RequestContext } from '@wetriip/service-kit';

/**
 * Versioned mapping.
 *
 * A mapping is the translation between a provider's codes and our catalog, and
 * getting it wrong silently sells the wrong room at the wrong price. So it is
 * never edited in place: you create a version, review its diff, publish it, and
 * you can roll back to the previous one. Every ARI event records the mapping
 * version that interpreted it, which is what makes a historical replay
 * reproducible after the mapping has changed.
 */
@Injectable()
export class MappingService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
  ) {}

  async activeMapping(connectionId: string): Promise<ResolvedMapping | null> {
    const version = await this.prisma.mappingVersion.findFirst({
      where: { connectionId, status: 'ACTIVE' },
      orderBy: { version: 'desc' },
      include: { entries: true, connection: true },
    });
    if (!version) return null;

    const roomTypes: Record<string, string> = {};
    const ratePlans: Record<string, string> = {};
    for (const e of version.entries) {
      if (e.entityType === 'ROOM_TYPE' && e.localRoomTypeId) roomTypes[e.remoteCode] = e.localRoomTypeId;
      if (e.entityType === 'RATE_PLAN' && e.localRatePlanId) ratePlans[e.remoteCode] = e.localRatePlanId;
    }
    return {
      version: version.version,
      propertyId: version.connection.propertyId,
      roomTypes,
      ratePlans,
    };
  }

  /** Adapters receive this, never the database. */
  toResolver(mapping: ResolvedMapping, tenantId: string): MappingResolver {
    return {
      version: mapping.version,
      roomTypeId: (code) => mapping.roomTypes[code] ?? null,
      ratePlanId: (code) => mapping.ratePlans[code] ?? null,
      propertyId: () => mapping.propertyId,
      tenantId: () => tenantId,
    };
  }

  async listVersions(connectionId: string) {
    return this.prisma.mappingVersion.findMany({
      where: { connectionId },
      orderBy: { version: 'desc' },
      include: { entries: true },
    });
  }

  async createVersion(
    ctx: RequestContext,
    connectionId: string,
    entries: Array<{
      entityType: 'PROPERTY' | 'ROOM_TYPE' | 'RATE_PLAN';
      remoteCode: string;
      remoteName?: string | null;
      localRoomTypeId?: string | null;
      localRatePlanId?: string | null;
      localPropertyId?: string | null;
    }>,
    note?: string,
  ) {
    const last = await this.prisma.mappingVersion.findFirst({
      where: { connectionId },
      orderBy: { version: 'desc' },
    });
    const version = (last?.version ?? 0) + 1;

    return this.prisma.mappingVersion.create({
      data: {
        connectionId,
        version,
        status: 'DRAFT',
        note: note ?? null,
        createdBy: ctx.userId,
        entries: {
          create: entries.map((e) => ({
            entityType: e.entityType,
            remoteCode: e.remoteCode,
            remoteName: e.remoteName ?? null,
            localRoomTypeId: e.localRoomTypeId ?? null,
            localRatePlanId: e.localRatePlanId ?? null,
            localPropertyId: e.localPropertyId ?? null,
          })),
        },
      },
      include: { entries: true },
    });
  }

  /**
   * Publishing retires the previous ACTIVE version in the same transaction.
   * Two active mappings on one connection would make every incoming event
   * ambiguous, so the invariant is enforced structurally, not by convention.
   */
  async publishVersion(ctx: RequestContext, connectionId: string, version: number) {
    const target = await this.prisma.mappingVersion.findFirst({
      where: { connectionId, version },
      include: { entries: true },
    });
    if (!target) {
      throw new DomainError({
        code: 'NOT_FOUND',
        message: `Mapping version ${version} not found for connection ${connectionId}`,
        owner: 'Catalog',
      });
    }
    const unmapped = target.entries.filter(
      (e) =>
        (e.entityType === 'ROOM_TYPE' && !e.localRoomTypeId) ||
        (e.entityType === 'RATE_PLAN' && !e.localRatePlanId),
    );
    if (unmapped.length) {
      throw new DomainError({
        code: 'INCOMPLETE_MAPPING',
        message: `${unmapped.length} entr(ies) have no local target`,
        owner: 'Catalog',
        remediation: 'Map every remote code, or remove the entries you do not intend to sell.',
        details: { unmapped: unmapped.map((u) => u.remoteCode) },
      });
    }

    const published = await this.prisma.$transaction(async (tx) => {
      await tx.mappingVersion.updateMany({
        where: { connectionId, status: 'ACTIVE' },
        data: { status: 'RETIRED', retiredAt: new Date() },
      });
      return tx.mappingVersion.update({
        where: { id: target.id },
        data: { status: 'ACTIVE', approvedBy: ctx.userId, publishedAt: new Date() },
        include: { entries: true },
      });
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorType: 'USER',
      actorId: ctx.userId,
      action: 'mapping.published',
      resourceType: 'MappingVersion',
      resourceId: published.id,
      after: { connectionId, version, entries: published.entries.length },
      correlationId: ctx.correlationId,
    });
    await this.bus.publish(
      'MappingPublished',
      { connectionId, version, entries: published.entries.length },
      { tenantId: ctx.tenantId, partitionKey: connectionId, correlationId: ctx.correlationId },
    );

    return published;
  }
}
