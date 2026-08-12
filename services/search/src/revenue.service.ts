import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import {
  CompetitivePosition,
  ConnectionHealthSnapshot,
  ContractRef,
  EffectiveAriRow,
  PartnerProduction,
  PropertyRef,
  RevenueAdvisory,
  StayDate,
  addDays,
  toStayDate,
} from '@wetriip/contracts';
import {
  BookingFact,
  OfferFact,
  PartnerFact,
  StaticFxProvider,
  advise,
  computeMetrics,
  computePartnerProduction,
  convert,
} from '@wetriip/domain';
import { toNumber, toStayDateString } from '@wetriip/persistence';
import { PRISMA, RequestContext, clients } from '@wetriip/service-kit';

/**
 * Revenue analytics read model.
 *
 * Lives in `search` because it spans domains the same way the diagnostic does:
 * catalog from core-commerce, inventory from ari-ingestion, bookings from
 * booking, connectivity health from connectivity. It owns none of that data and
 * reads all of it through APIs, never joins.
 *
 * The arithmetic and the opinions both live in `@wetriip/domain`. This file
 * gathers evidence and hands it over — which is what keeps the advisory
 * reproducible from its inputs in a unit test.
 */
@Injectable()
export class RevenueService {
  private readonly fx = new StaticFxProvider();

  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /**
   * Bookings are stored in the BUYER's currency — an agency in Mexico pays MXN
   * for a hotel that invoices COP. Aggregating those directly produces an ADR
   * that is not a price in any currency at all.
   *
   * So every amount is brought into the property currency before it reaches the
   * metrics engine, and the fact that a conversion happened is reported rather
   * than hidden.
   */
  private toPropertyCurrency(
    bookings: any[],
    propertyCurrency: string,
    at: Date,
  ): { facts: BookingFact[]; failures: string[] } {
    const failures: string[] = [];
    const facts: BookingFact[] = [];

    for (const b of bookings) {
      const from = (b.currencyCode ?? propertyCurrency).toUpperCase();
      const raw = Number(b.amount ?? 0);
      let amount = raw;
      let converted = false;

      if (from !== propertyCurrency.toUpperCase()) {
        try {
          amount = convert(raw, this.fx.quote(from, propertyCurrency, at));
          converted = true;
        } catch {
          failures.push(`${b.reference ?? b.id}: no FX rate ${from} to ${propertyCurrency}`);
          continue;
        }
      }

      facts.push({
        id: b.id,
        buyerOrgId: b.buyerOrgId,
        checkIn: b.checkIn,
        checkOut: b.checkOut,
        nights: b.nights,
        amount,
        currencyCode: propertyCurrency,
        converted,
        status: b.status,
        createdAt: new Date(b.createdAt),
      });
    }

    return { facts, failures };
  }

  async advisory(
    ctx: RequestContext,
    args: { propertyId: string; from?: StayDate | null; to?: StayDate | null },
  ): Promise<RevenueAdvisory> {
    const from = args.from ?? toStayDate(new Date());
    const to = args.to ?? addDays(from, 30);

    const [property, catalog, cells, connections, contracts, organizations] = await Promise.all([
      clients.coreCommerce.get<PropertyRef>(`/internal/core/properties/${args.propertyId}`, ctx),
      clients.coreCommerce.get<any>(`/internal/core/properties/${args.propertyId}/catalog`, ctx),
      clients.ari.get<EffectiveAriRow[]>(
        `/internal/ari/effective?propertyId=${args.propertyId}&from=${from}&to=${to}`,
        ctx,
      ),
      clients.connectivity
        .get<ConnectionHealthSnapshot[]>(
          `/internal/connectivity/health?propertyId=${args.propertyId}`,
          ctx,
        )
        .catch(() => [] as ConnectionHealthSnapshot[]),
      clients.coreCommerce.get<ContractRef[]>(
        `/internal/core/contracts?propertyId=${args.propertyId}`,
        ctx,
      ),
      clients.coreCommerce.get<any[]>('/internal/core/organizations', ctx),
    ]);

    const bookings = await clients.booking
      .get<any[]>(`/internal/booking?propertyId=${args.propertyId}&limit=500`, ctx)
      .catch(() => [] as any[]);

    const { facts: bookingFacts, failures: fxFailures } = this.toPropertyCurrency(
      bookings,
      property.currency,
      new Date(),
    );

    // Offers are ours, so they come straight from our own table.
    const offerRows = await this.prisma.offer.findMany({
      where: {
        tenantId: ctx.tenantId,
        propertyId: args.propertyId,
        createdAt: { gte: new Date(Date.now() - 90 * 86_400_000) },
      },
      take: 5000,
    });
    const offerFacts: OfferFact[] = offerRows.map((o) => ({
      propertyId: o.propertyId,
      roomTypeId: o.roomTypeId,
      ratePlanId: o.ratePlanId,
      checkIn: toStayDateString(o.checkIn),
      nights: o.nights,
      supplierAmount: toNumber(o.supplierAmount) ?? 0,
      createdAt: o.createdAt,
    }));

    const searches = await this.prisma.searchRequest.count({
      where: {
        tenantId: ctx.tenantId,
        createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
        OR: [{ propertyIds: { has: args.propertyId } }, { destination: property.city }],
      },
    });

    const metrics = computeMetrics({
      propertyId: property.id,
      propertyName: property.name,
      currency: property.currency,
      window: { from, to },
      roomInventory: (catalog.roomTypes ?? []).map((r: any) => ({
        roomTypeId: r.id,
        quantity: r.quantity,
      })),
      cells,
      bookings: bookingFacts,
      offers: offerFacts,
      searches,
      now: new Date(),
      fxSource: this.fx.source,
    });

    const partnerFacts: PartnerFact[] = organizations.map((o) => {
      const contract = contracts.find((c) => c.buyerOrgId === o.id && c.status === 'PUBLISHED');
      return {
        organizationId: o.id,
        name: o.name,
        type: o.type,
        country: o.country,
        contractCode: contract?.code ?? null,
        commissionPct: contract?.commissionPct ?? null,
        markupPct: contract?.markupPct ?? null,
      };
    });
    const partners = computePartnerProduction(bookingFacts, partnerFacts);

    const competitive = await this.competitivePosition(
      ctx,
      property.city,
      from,
      to,
      args.propertyId,
      metrics.averageOfferedRate,
    );

    const dataIssues: string[] = [];
    for (const c of connections) {
      for (const issue of c.issues) dataIssues.push(`${c.provider}: ${issue}`);
    }
    if (fxFailures.length) {
      dataIssues.push(
        `${fxFailures.length} booking(s) could not be converted into ${property.currency} and are excluded from these figures: ${fxFailures.slice(0, 3).join('; ')}.`,
      );
    }
    if ((catalog.roomTypes ?? []).every((r: any) => r.quantity === 0)) {
      dataIssues.push(
        'No room quantities are configured, so occupancy and RevPAR have no denominator.',
      );
    }

    return advise({ metrics, competitive, partners, cells, now: new Date(), dataIssues });
  }

  async partnerProduction(
    ctx: RequestContext,
    args: { propertyId: string; sinceDays?: number },
  ): Promise<PartnerProduction[]> {
    const since = args.sinceDays ?? 90;
    const [contracts, organizations, bookings] = await Promise.all([
      clients.coreCommerce.get<ContractRef[]>(
        `/internal/core/contracts?propertyId=${args.propertyId}`,
        ctx,
      ),
      clients.coreCommerce.get<any[]>('/internal/core/organizations', ctx),
      clients.booking
        .get<any[]>(`/internal/booking?propertyId=${args.propertyId}&limit=500`, ctx)
        .catch(() => [] as any[]),
    ]);

    const property = await clients.coreCommerce.get<PropertyRef>(
      `/internal/core/properties/${args.propertyId}`,
      ctx,
    );
    const cutoff = Date.now() - since * 86_400_000;
    const { facts } = this.toPropertyCurrency(
      bookings.filter((b) => new Date(b.createdAt).getTime() >= cutoff),
      property.currency,
      new Date(),
    );

    const partnerFacts: PartnerFact[] = organizations.map((o) => {
      const contract = contracts.find((c) => c.buyerOrgId === o.id && c.status === 'PUBLISHED');
      return {
        organizationId: o.id,
        name: o.name,
        type: o.type,
        country: o.country,
        contractCode: contract?.code ?? null,
        commissionPct: contract?.commissionPct ?? null,
        markupPct: contract?.markupPct ?? null,
      };
    });

    return computePartnerProduction(facts, partnerFacts);
  }

  /**
   * Competitive set derived from this platform's own inventory in the same
   * city. It is a proxy and the `basis` field says so — a rate shopper is a
   * later integration, and putting a confident number behind a guess is how
   * a revenue manager gets misled.
   */
  private async competitivePosition(
    ctx: RequestContext,
    city: string,
    from: StayDate,
    to: StayDate,
    excludePropertyId: string,
    ourAverageRate: number | null,
  ): Promise<CompetitivePosition> {
    const peers = await this.prisma.$queryRawUnsafe<Array<{ baseAmount: any }>>(
      `SELECT e."baseAmount"
         FROM "EffectiveAri" e
         JOIN "Property" p ON p.id = e."propertyId"
        WHERE e."tenantId" = $1
          AND p.city = $2
          AND e."propertyId" <> $3
          AND e."stayDate" BETWEEN $4::date AND $5::date
          AND e."baseAmount" IS NOT NULL
          AND e.open = true`,
      ctx.tenantId,
      city,
      excludePropertyId,
      from,
      to,
    );

    if (peers.length < 10) {
      return {
        medianPeerRate: null,
        ourAverageRate,
        deltaPct: null,
        sampleSize: peers.length,
        basis: `Only ${peers.length} comparable inventory cells in ${city}. Not enough to judge rate position; no competitive claim made.`,
      };
    }

    const values = peers.map((p) => Number(p.baseAmount)).sort((a, b) => a - b);
    const medianPeerRate = values[Math.floor(values.length / 2)];
    const deltaPct =
      ourAverageRate != null && medianPeerRate > 0
        ? Math.round(((ourAverageRate - medianPeerRate) / medianPeerRate) * 1000) / 10
        : null;

    return {
      medianPeerRate,
      ourAverageRate,
      deltaPct,
      sampleSize: values.length,
      basis: `Median open rate across ${values.length} peer inventory cells in ${city} on this platform. A proxy for a competitive set, not a rate-shopper feed.`,
    };
  }
}
