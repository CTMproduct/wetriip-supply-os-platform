import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { EventBus } from '@wetriip/bus';
import {
  ContractDefinition,
  ContractDefinitionSchema,
  ContractRef,
  DomainError,
  PromotionDefinition,
  PromotionDefinitionSchema,
  PromotionRef,
} from '@wetriip/contracts';
import { AuditLog, toNumber } from '@wetriip/persistence';
import { AUDIT_LOG, EVENT_BUS, PRISMA, RequestContext } from '@wetriip/service-kit';

/**
 * Contracts and promotions.
 *
 * Two rules govern this whole file:
 *
 *  1. NOTHING IS EVER OVERWRITTEN. A change writes a new version row and
 *     bumps the pointer. That is what makes "undo what we did this morning"
 *     a supported operation rather than a restore from backup.
 *
 *  2. Publishing is a distinct act from editing. A draft has no effect on any
 *     price; only a published version compiles into the rules the pricing
 *     pipeline reads.
 */
@Injectable()
export class CommercialService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
  ) {}

  // ── Contracts ────────────────────────────────────────────

  async createContract(ctx: RequestContext, input: unknown): Promise<ContractRef> {
    const def: ContractDefinition = ContractDefinitionSchema.parse(input);

    const existing = await this.prisma.contract.findFirst({
      where: { tenantId: ctx.tenantId, code: def.code },
    });
    if (existing) {
      throw new DomainError({
        code: 'CONFLICT',
        message: `A contract with code ${def.code} already exists`,
        owner: 'Commercial',
        remediation: 'Publish a new version of the existing contract instead of duplicating it.',
      });
    }

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.contract.create({
        data: {
          tenantId: ctx.tenantId,
          code: def.code,
          name: def.name,
          supplierOrgId: def.supplierOrgId,
          buyerOrgId: def.buyerOrgId,
          status: 'DRAFT',
          version: 1,
          validFrom: new Date(def.validFrom),
          validTo: new Date(def.validTo),
          currency: def.currency,
          paymentModel: def.paymentModel,
          commissionPct: def.commissionPct,
          markupPct: def.markupPct,
          creditLimit: def.creditLimit ?? null,
          markets: def.markets,
          channels: def.channels,
          propertyIds: def.propertyIds,
          cancellationPolicy: (def.cancellationPolicy ?? null) as any,
          promotionPermissions: def.promotionPermissions as any,
          distributionPermissions: def.distributionPermissions as any,
          maxResaleDepth: def.maxResaleDepth,
        },
      });
      await tx.contractVersion.create({
        data: { contractId: created.id, version: 1, snapshot: def as any, createdBy: ctx.userId },
      });
      return created;
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorType: 'USER',
      actorId: ctx.userId,
      action: 'contract.created',
      resourceType: 'Contract',
      resourceId: row.id,
      after: def,
      correlationId: ctx.correlationId,
    });
    await this.bus.publish(
      'ContractCreated',
      { contractId: row.id, code: def.code },
      { tenantId: ctx.tenantId, partitionKey: row.id, correlationId: ctx.correlationId },
    );

    return toContractRef(row);
  }

  async publishContract(ctx: RequestContext, contractId: string): Promise<ContractRef> {
    const row = await this.prisma.contract.findFirst({
      where: { id: contractId, tenantId: ctx.tenantId },
    });
    if (!row) throw notFound('Contract', contractId);
    if (row.status === 'PUBLISHED') return toContractRef(row);

    const updated = await this.prisma.contract.update({
      where: { id: contractId },
      data: { status: 'PUBLISHED', publishedAt: new Date(), publishedBy: ctx.userId },
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorType: 'USER',
      actorId: ctx.userId,
      action: 'contract.published',
      resourceType: 'Contract',
      resourceId: contractId,
      before: { status: row.status },
      after: { status: 'PUBLISHED', version: row.version },
      correlationId: ctx.correlationId,
    });
    await this.bus.publish(
      'ContractPublished',
      { contractId, version: row.version },
      { tenantId: ctx.tenantId, partitionKey: contractId, correlationId: ctx.correlationId },
    );

    return toContractRef(updated);
  }

  async listContracts(
    ctx: RequestContext,
    filter: { buyerOrgId?: string; propertyId?: string; status?: string } = {},
  ): Promise<ContractRef[]> {
    const rows = await this.prisma.contract.findMany({
      where: {
        tenantId: ctx.tenantId,
        ...(filter.buyerOrgId ? { buyerOrgId: filter.buyerOrgId } : {}),
        ...(filter.status ? { status: filter.status as any } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    const refs = rows.map(toContractRef);
    // Empty propertyIds means "all properties in scope" — a common contract
    // shape that a naive filter would wrongly exclude.
    return filter.propertyId
      ? refs.filter((c) => c.propertyIds.length === 0 || c.propertyIds.includes(filter.propertyId!))
      : refs;
  }

  /** The contract the pricing pipeline should apply for a given buyer and
   *  property today. When several qualify we take the most specific scope,
   *  then the most recently published — chosen once, here, so search and
   *  booking can never disagree. */
  async resolveContract(
    ctx: RequestContext,
    args: { buyerOrgId: string; propertyId: string; market: string; channel: string; on: string },
  ): Promise<ContractRef | null> {
    const candidates = await this.listContracts(ctx, {
      buyerOrgId: args.buyerOrgId,
      status: 'PUBLISHED',
    });
    const eligible = candidates.filter(
      (c) =>
        c.validFrom <= args.on &&
        c.validTo >= args.on &&
        (c.propertyIds.length === 0 || c.propertyIds.includes(args.propertyId)) &&
        (c.markets.length === 0 || c.markets.includes(args.market)) &&
        (c.channels.length === 0 || c.channels.includes(args.channel)),
    );
    if (eligible.length === 0) return null;
    eligible.sort((a, b) => {
      const spec = (c: ContractRef) =>
        (c.propertyIds.length ? 1 : 0) + (c.markets.length ? 1 : 0) + (c.channels.length ? 1 : 0);
      const d = spec(b) - spec(a);
      return d !== 0 ? d : b.validFrom.localeCompare(a.validFrom);
    });
    return eligible[0];
  }

  // ── Promotions ───────────────────────────────────────────

  async createPromotion(
    ctx: RequestContext,
    input: { code: string; name: string; definition: unknown; validFrom: string; validTo: string; publish?: boolean },
  ): Promise<PromotionRef> {
    const definition: PromotionDefinition = PromotionDefinitionSchema.parse(input.definition);

    const property = await this.prisma.property.findFirst({
      where: { id: definition.scope.propertyId, tenantId: ctx.tenantId },
    });
    if (!property) throw notFound('Property', definition.scope.propertyId);

    // Only a LIVE promotion holds its code. A cancelled or expired one keeps
    // its row and its version history but releases the name, so a hotel can
    // recreate a promotion it cancelled for having the wrong terms.
    const existing = await this.prisma.promotion.findFirst({
      where: {
        tenantId: ctx.tenantId,
        code: input.code,
        status: { in: ['DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'PAUSED'] },
      },
    });
    if (existing) {
      throw new DomainError({
        code: 'CONFLICT',
        message: `Promotion code ${input.code} is in use by a live promotion`,
        owner: 'Commercial',
        remediation:
          'Update that promotion to create a new version, cancel it first, or choose a different code.',
        details: { promotionId: existing.id, status: existing.status },
      });
    }

    const status = input.publish ? 'ACTIVE' : 'DRAFT';
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.promotion.create({
        data: {
          tenantId: ctx.tenantId,
          propertyId: definition.scope.propertyId,
          code: input.code,
          name: input.name,
          type: definition.type,
          status,
          version: 1,
          definition: definition as any,
          priority: definition.stacking?.priority ?? 100,
          stackable: definition.stacking?.allowed ?? false,
          validFrom: new Date(input.validFrom),
          validTo: new Date(input.validTo),
          createdBy: ctx.userId,
          publishedAt: input.publish ? new Date() : null,
        },
      });
      await tx.promotionVersion.create({
        data: {
          promotionId: created.id,
          version: 1,
          definition: definition as any,
          status,
          reason: 'initial version',
          createdBy: ctx.userId,
        },
      });
      return created;
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorType: ctx.userId.startsWith('agent') ? 'AGENT' : 'USER',
      actorId: ctx.userId,
      action: input.publish ? 'promotion.published' : 'promotion.created',
      resourceType: 'Promotion',
      resourceId: row.id,
      after: { code: input.code, definition },
      correlationId: ctx.correlationId,
    });
    await this.bus.publish(
      input.publish ? 'PromotionPublished' : 'PromotionCreated',
      { promotionId: row.id, propertyId: row.propertyId, version: 1 },
      { tenantId: ctx.tenantId, partitionKey: row.propertyId, correlationId: ctx.correlationId },
    );

    return toPromotionRef(row);
  }

  async listPromotions(
    ctx: RequestContext,
    filter: { propertyId?: string; activeOn?: string } = {},
  ): Promise<PromotionRef[]> {
    const rows = await this.prisma.promotion.findMany({
      where: {
        tenantId: ctx.tenantId,
        ...(filter.propertyId ? { propertyId: filter.propertyId } : {}),
        ...(filter.activeOn
          ? {
              status: 'ACTIVE',
              validFrom: { lte: new Date(filter.activeOn) },
              validTo: { gte: new Date(filter.activeOn) },
            }
          : {}),
      },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    });
    return rows.map(toPromotionRef);
  }

  /**
   * Edit a live promotion.
   *
   * Partial by design: only the fields supplied change, and everything else is
   * carried forward from the current version. "Change the Mexico promo to 12%"
   * must not silently clear its booking window.
   *
   * The result is a new version, never an in-place edit — same rule as
   * everything else in this file.
   */
  async updatePromotion(
    ctx: RequestContext,
    promotionId: string,
    changes: Record<string, any>,
    reason: string,
  ): Promise<PromotionRef> {
    const promo = await this.prisma.promotion.findFirst({
      where: { id: promotionId, tenantId: ctx.tenantId },
    });
    if (!promo) throw notFound('Promotion', promotionId);

    const current = promo.definition as unknown as PromotionDefinition;
    const next: any = JSON.parse(JSON.stringify(current));

    const set = (path: string[], value: any) => {
      if (value === undefined || value === null) return;
      let node = next;
      for (const key of path.slice(0, -1)) {
        node[key] = node[key] ?? {};
        node = node[key];
      }
      node[path[path.length - 1]] = value;
    };

    set(['discount', 'value'], changes.discountValue);
    set(['audience', 'markets'], changes.markets);
    set(['audience', 'organizationIds'], changes.organizationIds);
    set(['audience', 'channels'], changes.channels);
    set(['stayWindow', 'from'], changes.stayFrom);
    set(['stayWindow', 'to'], changes.stayTo);
    set(['stayWindow', 'daysOfWeek'], changes.daysOfWeek);
    set(['bookingWindow', 'minAdvanceDays'], changes.minAdvanceDays);
    set(['los', 'min'], changes.minLos);
    set(['los', 'max'], changes.maxLos);
    set(['scope', 'roomTypeCodes'], changes.roomTypeCodes);
    set(['scope', 'ratePlanCodes'], changes.ratePlanCodes);
    set(['stacking', 'allowed'], changes.stackable);
    set(['stacking', 'priority'], changes.priority);

    // Re-validated in full: a partial edit must still produce a legal rule.
    const definition = PromotionDefinitionSchema.parse(next);
    const nextVersion = promo.version + 1;

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.promotion.update({
        where: { id: promotionId },
        data: {
          version: nextVersion,
          definition: definition as any,
          name: changes.name ?? promo.name,
          priority: definition.stacking?.priority ?? promo.priority,
          stackable: definition.stacking?.allowed ?? promo.stackable,
        },
      });
      await tx.promotionVersion.create({
        data: {
          promotionId,
          version: nextVersion,
          definition: definition as any,
          status: promo.status,
          reason,
          supersedesVersion: promo.version,
          createdBy: ctx.userId,
        },
      });
      return u;
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorType: ctx.userId.startsWith('agent') ? 'AGENT' : 'USER',
      actorId: ctx.userId,
      action: 'promotion.updated',
      resourceType: 'Promotion',
      resourceId: promotionId,
      before: { version: promo.version, definition: current },
      after: { version: nextVersion, definition },
      reason,
      correlationId: ctx.correlationId,
    });
    await this.bus.publish(
      'PromotionPublished',
      { promotionId, propertyId: promo.propertyId, version: nextVersion },
      { tenantId: ctx.tenantId, partitionKey: promo.propertyId, correlationId: ctx.correlationId },
    );

    return toPromotionRef(updated);
  }

  /** Pause, resume or cancel. Always a new version. */
  async setPromotionStatus(
    ctx: RequestContext,
    promotionId: string,
    status: 'ACTIVE' | 'PAUSED' | 'CANCELLED',
    reason: string,
  ): Promise<PromotionRef> {
    const promo = await this.prisma.promotion.findFirst({
      where: { id: promotionId, tenantId: ctx.tenantId },
    });
    if (!promo) throw notFound('Promotion', promotionId);

    if (promo.status === 'CANCELLED' && status !== 'CANCELLED') {
      throw new DomainError({
        code: 'CONFLICT',
        message: 'A cancelled promotion cannot be reactivated',
        owner: 'Commercial',
        remediation: 'Create a new promotion; the cancelled one stays in history.',
      });
    }

    const nextVersion = promo.version + 1;
    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.promotion.update({
        where: { id: promotionId },
        data: {
          status,
          version: nextVersion,
          publishedAt: status === 'ACTIVE' ? (promo.publishedAt ?? new Date()) : promo.publishedAt,
        },
      });
      await tx.promotionVersion.create({
        data: {
          promotionId,
          version: nextVersion,
          definition: promo.definition as any,
          status,
          reason,
          supersedesVersion: promo.version,
          createdBy: ctx.userId,
        },
      });
      return u;
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorType: 'USER',
      actorId: ctx.userId,
      action: `promotion.${status.toLowerCase()}`,
      resourceType: 'Promotion',
      resourceId: promotionId,
      before: { status: promo.status, version: promo.version },
      after: { status, version: nextVersion },
      reason,
      correlationId: ctx.correlationId,
    });

    return toPromotionRef(updated);
  }

  /**
   * Rollback = a NEW version carrying the previous definition. History is
   * append-only, so an undo is itself auditable and itself undoable.
   */
  async rollbackPromotion(
    ctx: RequestContext,
    promotionId: string,
    toVersion: number | null,
    reason: string,
  ): Promise<PromotionRef> {
    const promo = await this.prisma.promotion.findFirst({
      where: { id: promotionId, tenantId: ctx.tenantId },
      include: { versions: { orderBy: { version: 'desc' } } },
    });
    if (!promo) throw notFound('Promotion', promotionId);

    const target = toVersion
      ? promo.versions.find((v) => v.version === toVersion)
      : promo.versions.find((v) => v.version < promo.version);

    if (!target) {
      throw new DomainError({
        code: 'CONFLICT',
        message: 'No earlier version to roll back to',
        owner: 'Commercial',
        remediation: 'Cancel the promotion instead, which also writes a new version.',
        details: { promotionId, currentVersion: promo.version },
      });
    }

    const nextVersion = promo.version + 1;
    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.promotion.update({
        where: { id: promotionId },
        data: {
          version: nextVersion,
          definition: target.definition as any,
          status: target.status,
        },
      });
      await tx.promotionVersion.create({
        data: {
          promotionId,
          version: nextVersion,
          definition: target.definition as any,
          status: target.status,
          reason,
          supersedesVersion: promo.version,
          createdBy: ctx.userId,
        },
      });
      return u;
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorType: 'USER',
      actorId: ctx.userId,
      action: 'promotion.rolled_back',
      resourceType: 'Promotion',
      resourceId: promotionId,
      before: { version: promo.version, definition: promo.definition },
      after: { version: nextVersion, restoredFrom: target.version },
      reason,
      correlationId: ctx.correlationId,
    });
    await this.bus.publish(
      'PromotionRolledBack',
      { promotionId, fromVersion: promo.version, toVersion: target.version, newVersion: nextVersion },
      { tenantId: ctx.tenantId, partitionKey: promo.propertyId, correlationId: ctx.correlationId },
    );

    return toPromotionRef(updated);
  }

  async cancelPromotion(ctx: RequestContext, promotionId: string, reason: string): Promise<PromotionRef> {
    const promo = await this.prisma.promotion.findFirst({
      where: { id: promotionId, tenantId: ctx.tenantId },
    });
    if (!promo) throw notFound('Promotion', promotionId);

    const nextVersion = promo.version + 1;
    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.promotion.update({
        where: { id: promotionId },
        data: { status: 'CANCELLED', version: nextVersion },
      });
      await tx.promotionVersion.create({
        data: {
          promotionId,
          version: nextVersion,
          definition: promo.definition as any,
          status: 'CANCELLED',
          reason,
          supersedesVersion: promo.version,
          createdBy: ctx.userId,
        },
      });
      return u;
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorType: 'USER',
      actorId: ctx.userId,
      action: 'promotion.cancelled',
      resourceType: 'Promotion',
      resourceId: promotionId,
      before: { status: promo.status },
      after: { status: 'CANCELLED' },
      reason,
      correlationId: ctx.correlationId,
    });
    return toPromotionRef(updated);
  }
}

function toContractRef(row: any): ContractRef {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    supplierOrgId: row.supplierOrgId,
    buyerOrgId: row.buyerOrgId,
    status: row.status,
    version: row.version,
    validFrom: row.validFrom.toISOString().slice(0, 10),
    validTo: row.validTo.toISOString().slice(0, 10),
    currency: row.currency,
    paymentModel: row.paymentModel,
    commissionPct: toNumber(row.commissionPct) ?? 0,
    markupPct: toNumber(row.markupPct) ?? 0,
    markets: row.markets ?? [],
    channels: row.channels ?? [],
    propertyIds: row.propertyIds ?? [],
    cancellationPolicy: row.cancellationPolicy ?? null,
    maxResaleDepth: row.maxResaleDepth,
  };
}

function toPromotionRef(row: any): PromotionRef {
  return {
    id: row.id,
    tenantId: row.tenantId,
    propertyId: row.propertyId,
    code: row.code,
    name: row.name,
    type: row.type,
    status: row.status,
    version: row.version,
    definition: row.definition,
    priority: row.priority,
    stackable: row.stackable,
    validFrom: row.validFrom.toISOString().slice(0, 10),
    validTo: row.validTo.toISOString().slice(0, 10),
  };
}

function notFound(type: string, id: string): DomainError {
  return new DomainError({
    code: 'NOT_FOUND',
    message: `${type} ${id} not found in this tenant`,
    owner: 'Commercial',
  });
}
