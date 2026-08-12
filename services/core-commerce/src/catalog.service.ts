import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { DomainError, PropertyRef, RatePlanRef, RoomTypeRef, TaxRuleRef } from '@wetriip/contracts';
import { AuditLog, toNumber } from '@wetriip/persistence';
import type { EventBus } from '@wetriip/bus';
import { AUDIT_LOG, EVENT_BUS, PRISMA, RequestContext } from '@wetriip/service-kit';

/**
 * Catalog.
 *
 * Owns what a hotel IS: property, rooms, rate plans, taxes and the approval
 * workflow. Deliberately does not own what a hotel COSTS or how much of it is
 * left — those change on a completely different clock and belong to ARI.
 *
 * Approval is a workflow state and nothing more. The audit's sharpest finding
 * was that "Approved" gets read as operational health; here approving a
 * property emits an event and grants nothing. Sellability is decided elsewhere,
 * every time, from live data.
 */
@Injectable()
export class CatalogService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
  ) {}

  async listProperties(ctx: RequestContext): Promise<PropertyRef[]> {
    const rows = await this.prisma.property.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { name: 'asc' },
    });
    return rows.map(toPropertyRef);
  }

  async getProperty(ctx: RequestContext, id: string): Promise<PropertyRef> {
    const row = await this.prisma.property.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!row) throw notFound('Property', id);
    return toPropertyRef(row);
  }

  /** Everything a pricing or diagnostic pass needs, in one call. Chatty
   *  per-entity fetches across a service boundary are how p95 dies. */
  async getCatalog(
    ctx: RequestContext,
    propertyId: string,
  ): Promise<{
    property: PropertyRef;
    roomTypes: RoomTypeRef[];
    ratePlans: RatePlanRef[];
    taxes: TaxRuleRef[];
  }> {
    const property = await this.prisma.property.findFirst({
      where: { id: propertyId, tenantId: ctx.tenantId },
      include: { roomTypes: true, ratePlans: true, taxes: true },
    });
    if (!property) throw notFound('Property', propertyId);

    return {
      property: toPropertyRef(property),
      roomTypes: property.roomTypes.map((r) => ({
        id: r.id,
        propertyId: r.propertyId,
        code: r.code,
        name: r.name,
        maxOccupancy: r.maxOccupancy,
        maxAdults: r.maxAdults,
        maxChildren: r.maxChildren,
        quantity: r.quantity,
        active: r.active,
      })),
      ratePlans: property.ratePlans.map((p) => ({
        id: p.id,
        propertyId: p.propertyId,
        code: p.code,
        name: p.name,
        mealPlan: p.mealPlan,
        currency: p.currency,
        source: p.source as 'EXTERNAL' | 'MANAGED',
        refundable: p.refundable,
        active: p.active,
      })),
      taxes: property.taxes.map((t) => ({
        id: t.id,
        propertyId: t.propertyId,
        code: t.code,
        name: t.name,
        mode: t.mode as TaxRuleRef['mode'],
        value: toNumber(t.value) ?? 0,
        currency: t.currency,
        included: t.included,
      })),
    };
  }

  async approveProperty(ctx: RequestContext, propertyId: string, reason?: string): Promise<PropertyRef> {
    const before = await this.getProperty(ctx, propertyId);
    if (before.status === 'APPROVED') return before;

    const updated = await this.prisma.property.update({
      where: { id: propertyId },
      data: { status: 'APPROVED', approvedAt: new Date(), approvedBy: ctx.userId },
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorType: 'USER',
      actorId: ctx.userId,
      action: 'property.approved',
      resourceType: 'Property',
      resourceId: propertyId,
      before: { status: before.status },
      after: { status: 'APPROVED' },
      reason: reason ?? null,
      correlationId: ctx.correlationId,
      ip: ctx.ip,
    });

    await this.bus.publish(
      'PropertyApproved',
      { propertyId, approvedBy: ctx.userId },
      { tenantId: ctx.tenantId, partitionKey: propertyId, correlationId: ctx.correlationId },
    );

    return toPropertyRef(updated);
  }

  async listOrganizations(ctx: RequestContext) {
    return this.prisma.organization.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        code: true,
        name: true,
        type: true,
        country: true,
        defaultCurrency: true,
        status: true,
      },
    });
  }
}

function toPropertyRef(row: any): PropertyRef {
  return {
    id: row.id,
    tenantId: row.tenantId,
    organizationId: row.organizationId,
    code: row.code,
    name: row.name,
    city: row.city,
    country: row.country,
    timezone: row.timezone,
    currency: row.currency,
    status: row.status,
  };
}

function notFound(type: string, id: string): DomainError {
  return new DomainError({
    code: 'NOT_FOUND',
    message: `${type} ${id} not found in this tenant`,
    owner: 'Catalog',
    remediation: 'Check the id and that your token is scoped to the right tenant.',
  });
}
