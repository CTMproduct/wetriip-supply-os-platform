import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import {
  ADDON_LABELS,
  DomainError,
  EventQuoteRequestSchema,
  EventSpaceAddonDef,
  EventSpaceRate,
  LAYOUT_LABELS,
  LayoutCapacity,
  UpsertEventSpaceSchema,
} from '@wetriip/contracts';
import { EventSpaceSpec, addonCatalog, assertCan, quoteEventSpace } from '@wetriip/domain';
import { AuditLog } from '@wetriip/persistence';
import { AUDIT_LOG, PRISMA, RequestContext } from '@wetriip/service-kit';
import { toNumber } from './util';

/**
 * Event spaces.
 *
 * Configuration and quoting live together because they are the same
 * conversation: a hotel loads a salón in order to be able to answer "cuánto por
 * el salón en U con coffee break para 40". If the two drifted apart the quote
 * would silently stop reflecting what the hotel actually configured.
 */
@Injectable()
export class EventSpaceService {
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
    assertCan(this.principal(ctx), 'events.read');
    const rows = await this.prisma.eventSpace.findMany({
      where: { tenantId: ctx.tenantId, ...(propertyId ? { propertyId } : {}) },
      orderBy: [{ propertyId: 'asc' }, { name: 'asc' }],
    });
    return rows.map((r) => this.shape(r));
  }

  async get(ctx: RequestContext, id: string) {
    assertCan(this.principal(ctx), 'events.read');
    const row = await this.prisma.eventSpace.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!row) {
      throw new DomainError({ code: 'NOT_FOUND', message: 'Event space not found', owner: 'Events' });
    }
    return this.shape(row);
  }

  private spec(row: any): EventSpaceSpec {
    return {
      id: row.id,
      name: row.name,
      currency: row.currency,
      halfDayHours: row.halfDayHours,
      fullDayHours: row.fullDayHours,
      layouts: (row.layouts as LayoutCapacity[]) ?? [],
      rates: (row.rates as EventSpaceRate[]) ?? [],
      addons: (row.addons as EventSpaceAddonDef[]) ?? [],
    };
  }

  private shape(row: any) {
    const spec = this.spec(row);
    const catalog = addonCatalog(spec);
    return {
      id: row.id,
      propertyId: row.propertyId,
      code: row.code,
      name: row.name,
      currency: row.currency,
      areaM2: toNumber(row.areaM2),
      ceilingHeightM: toNumber(row.ceilingHeightM),
      naturalLight: row.naturalLight,
      divisible: row.divisible,
      floor: row.floor,
      halfDayHours: row.halfDayHours,
      fullDayHours: row.fullDayHours,
      active: row.active,
      notes: row.notes,
      layouts: spec.layouts.map((l) => ({ ...l, label: LAYOUT_LABELS[l.layout] })),
      rates: spec.rates,
      equipment: catalog.equipment.map((a) => ({ ...a, label: ADDON_LABELS[a.kind] })),
      catering: catalog.catering.map((a) => ({ ...a, label: ADDON_LABELS[a.kind] })),
      /** The single number a salesperson quotes over the phone. */
      maxCapacity: spec.layouts.reduce((m, l) => Math.max(m, l.capacity), 0),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async upsert(ctx: RequestContext, input: unknown) {
    assertCan(this.principal(ctx), 'events.write');
    const s = UpsertEventSpaceSchema.parse(input);
    assertCan(this.principal(ctx), 'events.write', s.propertyId);

    const property = await this.prisma.property.findFirst({
      where: { id: s.propertyId, tenantId: ctx.tenantId },
    });
    if (!property) {
      throw new DomainError({ code: 'NOT_FOUND', message: 'Property not found', owner: 'Events' });
    }

    const existing = await this.prisma.eventSpace.findFirst({
      where: { tenantId: ctx.tenantId, propertyId: s.propertyId, code: s.code },
    });

    const row = await this.prisma.eventSpace.upsert({
      where: existing
        ? { id: existing.id }
        : { tenantId_propertyId_code: { tenantId: ctx.tenantId, propertyId: s.propertyId, code: s.code } },
      create: {
        tenantId: ctx.tenantId,
        propertyId: s.propertyId,
        code: s.code,
        name: s.name,
        currency: s.currency,
        areaM2: s.areaM2,
        ceilingHeightM: s.ceilingHeightM,
        naturalLight: s.naturalLight,
        divisible: s.divisible,
        floor: s.floor,
        halfDayHours: s.halfDayHours,
        fullDayHours: s.fullDayHours,
        layouts: s.layouts as any,
        rates: s.rates as any,
        addons: s.addons as any,
        active: s.active,
        notes: s.notes,
        updatedBy: ctx.userId,
      },
      update: {
        name: s.name,
        currency: s.currency,
        areaM2: s.areaM2,
        ceilingHeightM: s.ceilingHeightM,
        naturalLight: s.naturalLight,
        divisible: s.divisible,
        floor: s.floor,
        halfDayHours: s.halfDayHours,
        fullDayHours: s.fullDayHours,
        layouts: s.layouts as any,
        rates: s.rates as any,
        addons: s.addons as any,
        active: s.active,
        notes: s.notes,
        updatedBy: ctx.userId,
      },
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorType: 'USER',
      actorId: ctx.userId,
      action: existing ? 'event.space.updated' : 'event.space.created',
      resourceType: 'EventSpace',
      resourceId: row.id,
      before: existing ? { layouts: existing.layouts, rates: existing.rates } : null,
      after: { layouts: s.layouts, rates: s.rates, addons: s.addons.length },
      correlationId: ctx.correlationId,
      ip: ctx.ip,
    });

    return this.get(ctx, row.id);
  }

  /**
   * A quote is a read. It computes, it explains, and it stores nothing — which
   * is what lets a salesperson try six shapes of the same event without leaving
   * six half-finished records behind.
   */
  async quote(ctx: RequestContext, input: unknown) {
    assertCan(this.principal(ctx), 'events.read');
    const q = EventQuoteRequestSchema.parse(input);

    const row = await this.prisma.eventSpace.findFirst({
      where: { id: q.spaceId, tenantId: ctx.tenantId },
    });
    if (!row) {
      throw new DomainError({ code: 'NOT_FOUND', message: 'Event space not found', owner: 'Events' });
    }
    if (!row.active) {
      throw new DomainError({
        code: 'CONFLICT',
        message: `${row.name} is not currently on sale.`,
        owner: 'Events',
        remediation: 'Reactivate the space before quoting it.',
      });
    }

    // Event space is taxed like any other service the property sells, so the
    // rate comes from the property's own tax rules rather than a constant.
    const taxes = await this.prisma.taxRule.findMany({
      where: { propertyId: row.propertyId, mode: 'PERCENTAGE' },
    });
    const taxPct = taxes.reduce((a, t) => a + (toNumber(t.value) ?? 0), 0);

    const quote = quoteEventSpace({ space: this.spec(row), request: q, taxPct });
    return { spaceId: row.id, spaceName: row.name, propertyId: row.propertyId, taxPct, ...quote };
  }
}
