import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { EventBus } from '@wetriip/bus';
import {
  DistributionDecision,
  DistributionPolicyRef,
  DistributionPolicySchema,
  DistributionRequest,
  DomainError,
} from '@wetriip/contracts';
import { evaluateDistribution } from '@wetriip/domain';
import { AuditLog, toNumber } from '@wetriip/persistence';
import { AUDIT_LOG, EVENT_BUS, PRISMA, RequestContext } from '@wetriip/service-kit';

/**
 * Distribution policy.
 *
 * The hotel's own answer to "who may see me". Owned here rather than in the
 * contract engine because a hotel must be able to close a market without
 * cancelling a contract, and open the marketplace without signing a thousand.
 */
@Injectable()
export class DistributionService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
  ) {}

  async get(ctx: RequestContext, propertyId: string): Promise<DistributionPolicyRef | null> {
    const row = await this.prisma.distributionPolicy.findFirst({
      where: { propertyId, tenantId: ctx.tenantId },
    });
    return row ? toRef(row) : null;
  }

  async upsert(ctx: RequestContext, propertyId: string, input: unknown): Promise<DistributionPolicyRef> {
    const policy = DistributionPolicySchema.parse(input);
    const property = await this.prisma.property.findFirst({
      where: { id: propertyId, tenantId: ctx.tenantId },
    });
    if (!property) {
      throw new DomainError({ code: 'NOT_FOUND', message: 'Property not found', owner: 'Catalog' });
    }

    // Every id on the allow and block lists must be a real organization in this
    // tenant. A typo here silently hides a hotel from a partner, and the hotel
    // has no way to tell that from a bug.
    const referenced = [...policy.allowedPartnerIds, ...policy.blockedPartnerIds];
    if (referenced.length) {
      const found = await this.prisma.organization.findMany({
        where: { id: { in: referenced }, tenantId: ctx.tenantId },
        select: { id: true },
      });
      const missing = referenced.filter((id) => !found.some((f) => f.id === id));
      if (missing.length) {
        throw new DomainError({
          code: 'VALIDATION',
          message: `Unknown organization id(s): ${missing.join(', ')}`,
          owner: 'Distribution',
          remediation: 'Use ids from GET /organizations. A typo here silently hides the hotel.',
          details: { missing },
        });
      }
    }

    const before = await this.prisma.distributionPolicy.findFirst({ where: { propertyId } });

    const row = await this.prisma.distributionPolicy.upsert({
      where: { propertyId },
      create: {
        tenantId: ctx.tenantId,
        propertyId,
        ...toDb(policy),
        updatedBy: ctx.userId,
      },
      update: { ...toDb(policy), version: { increment: 1 }, updatedBy: ctx.userId },
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorType: 'USER',
      actorId: ctx.userId,
      action: 'distribution.updated',
      resourceType: 'DistributionPolicy',
      resourceId: row.id,
      before: before ? toRef(before) : null,
      after: toRef(row),
      reason: policy.note ?? null,
      correlationId: ctx.correlationId,
    });

    await this.bus.publish(
      before && before.mode !== row.mode ? 'PartnerBlocked' : 'PartnerEnabled',
      { propertyId, mode: row.mode, version: row.version },
      { tenantId: ctx.tenantId, partitionKey: propertyId, correlationId: ctx.correlationId },
    );

    return toRef(row);
  }

  /** Used by search before any pricing work happens. */
  async evaluate(
    ctx: RequestContext,
    propertyId: string,
    request: Omit<DistributionRequest, 'now'>,
  ): Promise<DistributionDecision> {
    const policy = await this.get(ctx, propertyId);
    return evaluateDistribution(policy, { ...request, now: new Date() });
  }

  /**
   * "Who can currently see this hotel, and who cannot, and why."
   * The question a hotel actually asks, answered without a support ticket.
   */
  async reach(ctx: RequestContext, propertyId: string) {
    const [policy, organizations] = await Promise.all([
      this.get(ctx, propertyId),
      this.prisma.organization.findMany({
        where: {
          tenantId: ctx.tenantId,
          type: { in: ['WHOLESALER', 'AGENCY', 'OTA', 'CORPORATE', 'DMC', 'TOUR_OPERATOR'] },
        },
        include: { partnerProfile: true },
      }),
    ]);

    const now = new Date();
    const checkIn = new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);

    return {
      policy,
      partners: organizations.map((org) => {
        const decision = evaluateDistribution(policy, {
          organizationId: org.id,
          organizationType: org.type,
          market: org.partnerProfile?.sourceMarkets?.[0] ?? org.country,
          channel: 'B2B',
          checkIn,
          nights: 2,
          now,
        });
        return {
          organizationId: org.id,
          name: org.name,
          type: org.type,
          country: org.country,
          partnerCode: org.partnerProfile?.partnerCode ?? null,
          status: org.partnerProfile?.status ?? 'PENDING',
          canSee: decision.allowed,
          reason: decision.reason,
          deniedBy: decision.deniedBy,
        };
      }),
    };
  }
}

function toDb(p: any) {
  return {
    mode: p.mode,
    allowedMarkets: p.allowedMarkets,
    blockedMarkets: p.blockedMarkets,
    allowedPartnerIds: p.allowedPartnerIds,
    blockedPartnerIds: p.blockedPartnerIds,
    allowedPartnerTypes: p.allowedPartnerTypes,
    allowedChannels: p.allowedChannels,
    minAdvanceDays: p.minAdvanceDays ?? null,
    maxAdvanceDays: p.maxAdvanceDays ?? null,
    minLos: p.minLos ?? null,
    floorRate: p.floorRate ?? null,
    floorCurrency: p.floorCurrency ?? null,
    requiresApproval: p.requiresApproval,
    note: p.note ?? null,
  };
}

function toRef(row: any): DistributionPolicyRef {
  return {
    id: row.id,
    propertyId: row.propertyId,
    mode: row.mode,
    allowedMarkets: row.allowedMarkets,
    blockedMarkets: row.blockedMarkets,
    allowedPartnerIds: row.allowedPartnerIds,
    blockedPartnerIds: row.blockedPartnerIds,
    allowedPartnerTypes: row.allowedPartnerTypes,
    allowedChannels: row.allowedChannels,
    minAdvanceDays: row.minAdvanceDays,
    maxAdvanceDays: row.maxAdvanceDays,
    minLos: row.minLos,
    floorRate: toNumber(row.floorRate),
    floorCurrency: row.floorCurrency,
    requiresApproval: row.requiresApproval,
    note: row.note,
    version: row.version,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}
