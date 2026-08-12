import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import {
  CreditDecision,
  CreditEntryRef,
  DomainError,
  PartnerProfileRef,
  PartnerProfileSchema,
} from '@wetriip/contracts';
import { StaticFxProvider, convert, evaluateCredit } from '@wetriip/domain';
import { AuditLog, toNumber } from '@wetriip/persistence';
import { AUDIT_LOG, PRISMA, RequestContext } from '@wetriip/service-kit';

/**
 * Partner profiles and credit.
 *
 * The credit balance is the running total of an append-only ledger and is never
 * set directly. A balance somebody can type over is a balance nobody trusts,
 * and reconciling it after the fact is impossible without the entries.
 */
@Injectable()
export class PartnerService {
  private readonly fx = new StaticFxProvider();

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
  ) {}

  async list(ctx: RequestContext): Promise<PartnerProfileRef[]> {
    const rows = await this.prisma.partnerProfile.findMany({
      where: { tenantId: ctx.tenantId },
      include: { organization: true },
      orderBy: { partnerCode: 'asc' },
    });
    return rows.map(toRef);
  }

  async get(ctx: RequestContext, idOrCode: string): Promise<PartnerProfileRef> {
    const row = await this.prisma.partnerProfile.findFirst({
      where: {
        tenantId: ctx.tenantId,
        OR: [{ id: idOrCode }, { partnerCode: idOrCode }, { organizationId: idOrCode }],
      },
      include: { organization: true },
    });
    if (!row) {
      throw new DomainError({
        code: 'NOT_FOUND',
        message: `No partner profile for ${idOrCode}`,
        owner: 'Commercial',
        remediation: 'Create the profile before transacting with this organization.',
      });
    }
    return toRef(row);
  }

  async upsert(ctx: RequestContext, input: unknown): Promise<PartnerProfileRef> {
    const p = PartnerProfileSchema.parse(input);

    const org = await this.prisma.organization.findFirst({
      where: { id: p.organizationId, tenantId: ctx.tenantId },
    });
    if (!org) {
      throw new DomainError({
        code: 'NOT_FOUND',
        message: 'Organization not found',
        owner: 'Commercial',
      });
    }

    const existing = await this.prisma.partnerProfile.findFirst({
      where: { organizationId: p.organizationId },
    });

    // The partner code is quoted on bookings and invoices. Once issued it is
    // an external identifier and changing it breaks reconciliation upstream.
    if (existing && existing.partnerCode !== p.partnerCode) {
      throw new DomainError({
        code: 'CONFLICT',
        message: 'The partner code cannot be changed once issued',
        owner: 'Commercial',
        remediation:
          'It appears on existing bookings and invoices. Create a new organization if this is genuinely a different counterparty.',
        details: { current: existing.partnerCode, attempted: p.partnerCode },
      });
    }

    const clash = await this.prisma.partnerProfile.findFirst({
      where: { tenantId: ctx.tenantId, partnerCode: p.partnerCode, NOT: { organizationId: p.organizationId } },
    });
    if (clash) {
      throw new DomainError({
        code: 'CONFLICT',
        message: `Partner code ${p.partnerCode} is already in use`,
        owner: 'Commercial',
      });
    }

    const row = await this.prisma.partnerProfile.upsert({
      where: { organizationId: p.organizationId },
      create: {
        tenantId: ctx.tenantId,
        organizationId: p.organizationId,
        partnerCode: p.partnerCode,
        status: p.status,
        legalName: p.legalName,
        taxIdScheme: p.taxIdScheme ?? null,
        taxId: p.taxId ?? null,
        taxCountry: p.taxCountry ?? null,
        billingEmail: p.billingEmail ?? null,
        billingAddress: p.billingAddress ?? null,
        billingCity: p.billingCity ?? null,
        billingCountry: p.billingCountry ?? null,
        contactName: p.contactName ?? null,
        contactPhone: p.contactPhone ?? null,
        sourceMarkets: p.sourceMarkets,
        iataCode: p.iataCode ?? null,
        memberships: p.memberships,
        paymentTerms: p.paymentTerms,
        currency: p.currency,
        creditLimit: p.creditLimit,
        creditWarningPct: p.creditWarningPct,
        notes: p.notes ?? null,
        onboardedAt: p.status === 'ACTIVE' ? new Date() : null,
      },
      update: {
        status: p.status,
        legalName: p.legalName,
        taxIdScheme: p.taxIdScheme ?? null,
        taxId: p.taxId ?? null,
        taxCountry: p.taxCountry ?? null,
        billingEmail: p.billingEmail ?? null,
        billingAddress: p.billingAddress ?? null,
        billingCity: p.billingCity ?? null,
        billingCountry: p.billingCountry ?? null,
        contactName: p.contactName ?? null,
        contactPhone: p.contactPhone ?? null,
        sourceMarkets: p.sourceMarkets,
        iataCode: p.iataCode ?? null,
        memberships: p.memberships,
        paymentTerms: p.paymentTerms,
        currency: p.currency,
        // creditLimit moves here; creditUsed only ever moves via the ledger.
        creditLimit: p.creditLimit,
        creditWarningPct: p.creditWarningPct,
        notes: p.notes ?? null,
        onboardedAt: existing?.onboardedAt ?? (p.status === 'ACTIVE' ? new Date() : null),
      },
      include: { organization: true },
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorType: 'USER',
      actorId: ctx.userId,
      action: existing ? 'partner.updated' : 'partner.created',
      resourceType: 'PartnerProfile',
      resourceId: row.id,
      before: existing ? { status: existing.status, creditLimit: toNumber(existing.creditLimit) } : null,
      after: { status: p.status, creditLimit: p.creditLimit },
      correlationId: ctx.correlationId,
    });

    return toRef(row);
  }

  async creditDecision(
    ctx: RequestContext,
    organizationId: string,
    amount: number,
    currency: string,
  ): Promise<CreditDecision> {
    const row = await this.prisma.partnerProfile.findFirst({
      where: { organizationId, tenantId: ctx.tenantId },
    });

    // No profile means nobody has decided this partner's terms. Defaulting to
    // "allowed" would let an unonboarded counterparty transact on credit
    // nobody granted, so the default is prepay.
    if (!row) {
      return {
        allowed: true,
        reason: null,
        requiresPrepay: true,
        limit: 0,
        used: 0,
        available: 0,
        requested: amount,
        currency,
        utilizationAfterPct: 0,
        warning: 'No partner profile exists for this buyer, so the booking is treated as prepay.',
      };
    }

    // A credit line in COP against a booking priced in USD is ordinary for a
    // multi-currency wholesaler. We convert into the line currency rather than
    // refusing, and the rate travels with the decision so the ledger entry can
    // record what it was converted at.
    let requested = amount;
    let fxNote: string | null = null;

    if (row.currency !== currency) {
      try {
        const quote = this.fx.quote(currency, row.currency, new Date());
        requested = convert(amount, quote);
        fxNote = `Converted ${amount} ${currency} to ${requested} ${row.currency} at ${quote.rate} (${quote.source}).`;
      } catch {
        return {
          allowed: false,
          reason: `No FX rate from ${currency} to the ${row.currency} credit line. The exposure cannot be measured, so the booking is not authorised on credit.`,
          requiresPrepay: true,
          limit: toNumber(row.creditLimit) ?? 0,
          used: toNumber(row.creditUsed) ?? 0,
          available: 0,
          requested: amount,
          currency,
          utilizationAfterPct: 0,
          warning: null,
        };
      }
    }

    const decision = evaluateCredit({
      status: row.status,
      paymentTerms: row.paymentTerms,
      limit: toNumber(row.creditLimit) ?? 0,
      used: toNumber(row.creditUsed) ?? 0,
      requested,
      currency: row.currency,
      warningPct: row.creditWarningPct,
    });

    return fxNote
      ? { ...decision, warning: [decision.warning, fxNote].filter(Boolean).join(' ') }
      : decision;
  }

  /**
   * Move the credit line. The entry and the running total commit together —
   * a ledger whose total can drift from its entries is worse than no ledger.
   */
  async recordCredit(
    ctx: RequestContext,
    args: {
      organizationId: string;
      type: 'HOLD' | 'RELEASE' | 'CHARGE' | 'PAYMENT' | 'ADJUSTMENT';
      amount: number;
      currency: string;
      bookingId?: string | null;
      reference?: string | null;
      reason?: string | null;
    },
  ): Promise<CreditEntryRef> {
    const partner = await this.prisma.partnerProfile.findFirst({
      where: { organizationId: args.organizationId, tenantId: ctx.tenantId },
    });
    if (!partner) {
      throw new DomainError({
        code: 'NOT_FOUND',
        message: 'No partner profile; cannot move a credit line that does not exist',
        owner: 'Commercial',
      });
    }

    // HOLD and CHARGE increase exposure; RELEASE and PAYMENT reduce it.
    const sign = args.type === 'HOLD' || args.type === 'CHARGE' ? 1 : -1;
    const delta = sign * Math.abs(args.amount);

    return this.prisma.$transaction(async (tx) => {
      const current = toNumber(partner.creditUsed) ?? 0;
      const balanceAfter = Math.max(0, Math.round((current + delta) * 100) / 100);

      await tx.partnerProfile.update({
        where: { id: partner.id },
        data: { creditUsed: balanceAfter },
      });

      const entry = await tx.creditEntry.create({
        data: {
          tenantId: ctx.tenantId,
          partnerId: partner.id,
          type: args.type,
          amount: Math.abs(args.amount),
          currency: args.currency,
          balanceAfter,
          bookingId: args.bookingId ?? null,
          reference: args.reference ?? null,
          reason: args.reason ?? null,
          actorId: ctx.userId,
          correlationId: ctx.correlationId,
        },
      });

      return {
        id: entry.id,
        type: entry.type,
        amount: toNumber(entry.amount) ?? 0,
        currency: entry.currency,
        balanceAfter,
        bookingId: entry.bookingId,
        reference: entry.reference,
        reason: entry.reason,
        createdAt: entry.createdAt.toISOString(),
      };
    });
  }

  async creditHistory(ctx: RequestContext, organizationId: string, limit = 50) {
    const partner = await this.prisma.partnerProfile.findFirst({
      where: { organizationId, tenantId: ctx.tenantId },
    });
    if (!partner) return [];
    const rows = await this.prisma.creditEntry.findMany({
      where: { partnerId: partner.id },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
    });
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      amount: toNumber(r.amount) ?? 0,
      currency: r.currency,
      balanceAfter: toNumber(r.balanceAfter) ?? 0,
      bookingId: r.bookingId,
      reference: r.reference,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}

function toRef(row: any): PartnerProfileRef {
  const limit = toNumber(row.creditLimit) ?? 0;
  const used = toNumber(row.creditUsed) ?? 0;
  const available = Math.max(0, limit - used);
  const utilization = limit > 0 ? Math.round((used / limit) * 1000) / 10 : 0;

  return {
    id: row.id,
    tenantId: row.tenantId,
    organizationId: row.organizationId,
    organizationName: row.organization?.name ?? row.legalName,
    organizationType: row.organization?.type ?? 'UNKNOWN',
    partnerCode: row.partnerCode,
    status: row.status,
    legalName: row.legalName,
    taxIdScheme: row.taxIdScheme,
    taxId: row.taxId,
    taxCountry: row.taxCountry,
    billingEmail: row.billingEmail,
    billingAddress: row.billingAddress,
    billingCity: row.billingCity,
    billingCountry: row.billingCountry,
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    sourceMarkets: row.sourceMarkets,
    iataCode: row.iataCode,
    memberships: row.memberships,
    paymentTerms: row.paymentTerms,
    currency: row.currency,
    creditLimit: limit,
    creditUsed: used,
    creditAvailable: available,
    creditUtilizationPct: utilization,
    creditWarning: limit > 0 && utilization >= row.creditWarningPct,
    creditWarningPct: row.creditWarningPct,
    notes: row.notes,
    onboardedAt: row.onboardedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
