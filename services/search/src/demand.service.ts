import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import {
  DemandWindow,
  PropertyDemandReport,
  PropertyRef,
  TravelFlowReport,
} from '@wetriip/contracts';
import {
  BuyerRef,
  DemandBookingFact,
  ImpressionFact,
  buildPropertyDemand,
  buildTravelFlow,
} from '@wetriip/domain';
import { toNumber, toStayDateString } from '@wetriip/persistence';
import { PRISMA, RequestContext, clients } from '@wetriip/service-kit';

/**
 * Demand intelligence read model.
 *
 * Reads the impression stream `search` writes on every request. The value is
 * not the count — it is that every impression carries the buyer, their source
 * market, the destination, and the predicate that stopped us when we could not
 * quote.
 */
@Injectable()
export class DemandService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  private window(days: number): DemandWindow {
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), days };
  }

  async propertyDemand(
    ctx: RequestContext,
    args: { propertyId: string; days?: number },
  ): Promise<PropertyDemandReport> {
    const days = args.days ?? 30;
    const window = this.window(days);
    const since = new Date(Date.now() - days * 86_400_000);

    const [property, organizations, partners, impressions, bookings] = await Promise.all([
      clients.coreCommerce.get<PropertyRef>(`/internal/core/properties/${args.propertyId}`, ctx),
      clients.coreCommerce.get<any[]>('/internal/core/organizations', ctx),
      clients.coreCommerce.get<any[]>('/internal/core/partners', ctx).catch(() => [] as any[]),
      this.prisma.searchImpression.findMany({
        where: { tenantId: ctx.tenantId, propertyId: args.propertyId, createdAt: { gte: since } },
        take: 20_000,
      }),
      clients.booking
        .get<any[]>(`/internal/booking?propertyId=${args.propertyId}&limit=500`, ctx)
        .catch(() => [] as any[]),
    ]);

    const buyers: BuyerRef[] = organizations.map((o) => ({
      organizationId: o.id,
      name: o.name,
      type: o.type,
      partnerCode: partners.find((p) => p.organizationId === o.id)?.partnerCode ?? null,
    }));

    return buildPropertyDemand({
      propertyId: property.id,
      propertyName: property.name,
      window,
      impressions: impressions.map(toImpressionFact),
      bookings: bookings
        .filter((b) => b.status === 'CONFIRMED' && new Date(b.createdAt).getTime() >= since.getTime())
        .map((b) => toBookingFact(b, property)),
      buyers,
      currency: property.currency,
      now: new Date(),
    });
  }

  /**
   * Outbound (emisivo) and inbound (receptivo).
   *
   * OUTBOUND anchors on a source market: "my Colombian buyers are searching
   * where?". INBOUND anchors on a destination country: "who is looking at
   * Colombia?". Same rows, read from opposite ends.
   *
   * The trend compares against the immediately preceding window of the same
   * length, which is why we fetch twice.
   */
  async travelFlow(
    ctx: RequestContext,
    args: { direction: 'OUTBOUND' | 'INBOUND'; anchor: string; days?: number },
  ): Promise<TravelFlowReport> {
    const days = args.days ?? 30;
    const window = this.window(days);
    const since = new Date(Date.now() - days * 86_400_000);
    const priorSince = new Date(Date.now() - 2 * days * 86_400_000);

    const where =
      args.direction === 'OUTBOUND'
        ? { sourceMarket: args.anchor.toUpperCase() }
        : { destinationCountry: args.anchor.toUpperCase() };

    const [impressions, prior] = await Promise.all([
      this.prisma.searchImpression.findMany({
        where: { tenantId: ctx.tenantId, ...where, createdAt: { gte: since } },
        take: 50_000,
      }),
      this.prisma.searchImpression.findMany({
        where: { tenantId: ctx.tenantId, ...where, createdAt: { gte: priorSince, lt: since } },
        take: 50_000,
      }),
    ]);

    // Bookings are reconstructed from offers, which carry the property, and
    // from the booking service, which carries the outcome. Offers are ours, so
    // the join happens here rather than as a cross-service query.
    const offerRows = await this.prisma.offer.findMany({
      where: { tenantId: ctx.tenantId, createdAt: { gte: since } },
      select: { id: true, propertyId: true, buyerOrgId: true, checkIn: true, nights: true },
      take: 20_000,
    });

    const [properties, allBookings] = await Promise.all([
      clients.coreCommerce.get<PropertyRef[]>('/internal/core/properties', ctx),
      clients.booking.get<any[]>('/internal/booking?limit=500', ctx).catch(() => [] as any[]),
    ]);
    const propertyById = new Map(properties.map((p) => [p.id, p]));
    const offerById = new Map(offerRows.map((o) => [o.id, o]));

    const bookings: DemandBookingFact[] = [];
    for (const b of allBookings) {
      if (b.status !== 'CONFIRMED') continue;
      if (new Date(b.createdAt).getTime() < since.getTime()) continue;
      const property = propertyById.get(b.propertyId);
      if (!property) continue;

      const impression = impressions.find(
        (i) => i.propertyId === b.propertyId && i.buyerOrgId === b.buyerOrgId,
      );
      const sourceMarket = impression?.sourceMarket ?? null;
      // Without an impression we cannot attribute a source market, and guessing
      // one would corrupt exactly the number this report exists to produce.
      if (!sourceMarket) continue;

      const matches =
        args.direction === 'OUTBOUND'
          ? sourceMarket === args.anchor.toUpperCase()
          : property.country === args.anchor.toUpperCase();
      if (!matches) continue;

      bookings.push({
        propertyId: b.propertyId,
        buyerOrgId: b.buyerOrgId,
        sourceMarket,
        destinationCountry: property.country,
        destinationCity: property.city,
        checkIn: b.checkIn,
        nights: b.nights,
        amount: Number(b.amount ?? 0),
        currency: b.currencyCode,
        createdAt: new Date(b.createdAt),
      });
    }

    return buildTravelFlow({
      direction: args.direction,
      anchor: args.anchor.toUpperCase(),
      window,
      impressions: impressions.map(toImpressionFact),
      bookings,
      priorImpressions: prior.map(toImpressionFact),
      currency: bookings[0]?.currency ?? 'USD',
      now: new Date(),
    });
  }
}

function toImpressionFact(r: any): ImpressionFact {
  return {
    propertyId: r.propertyId,
    buyerOrgId: r.buyerOrgId,
    sourceMarket: r.sourceMarket,
    destinationCountry: r.destinationCountry,
    destinationCity: r.destinationCity,
    checkIn: toStayDateString(r.checkIn),
    nights: r.nights,
    offered: r.offered,
    offerCount: r.offerCount,
    lowestRate: toNumber(r.lowestRate),
    currency: r.currency,
    blockedBy: r.blockedBy ?? [],
    createdAt: r.createdAt,
  };
}

function toBookingFact(b: any, property: PropertyRef): DemandBookingFact {
  return {
    propertyId: b.propertyId,
    buyerOrgId: b.buyerOrgId,
    sourceMarket: '—',
    destinationCountry: property.country,
    destinationCity: property.city,
    checkIn: b.checkIn,
    nights: b.nights,
    amount: Number(b.amount ?? 0),
    currency: b.currencyCode,
    createdAt: new Date(b.createdAt),
  };
}
