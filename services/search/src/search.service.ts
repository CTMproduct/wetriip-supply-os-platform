import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { EventBus } from '@wetriip/bus';
import {
  ContractRef,
  DistributionDecision,
  DomainError,
  EffectiveAriRow,
  HotelOffer,
  PromotionRef,
  PropertyRef,
  RatePlanRef,
  RoomTypeRef,
  SearchRequestInput,
  SearchRequestSchema,
  SearchResponse,
  StayDate,
  TaxRuleRef,
  dateRange,
  nightsBetween,
  toStayDate,
} from '@wetriip/contracts';
import {
  PromotionContext,
  StaticFxProvider,
  buildPriceBreakdown,
  evaluateSellability,
  signOffer,
} from '@wetriip/domain';
import { M, metrics } from '@wetriip/observability';
import { EVENT_BUS, PRISMA, RequestContext, clients } from '@wetriip/service-kit';

/**
 * Search and offer construction.
 *
 * The rule that shapes this file: an offer only exists when EVERY predicate is
 * true, and when one is false we say which. `excluded[]` in the response is not
 * a debugging nicety — it is the difference between a hotel being told "no
 * results" and being told "your BAR plan is closed to arrival on the dates they
 * searched".
 *
 * The pricing itself is delegated to @wetriip/domain, which is pure. Search
 * fetches state and assembles inputs; it does not do arithmetic on money.
 */
@Injectable()
export class SearchService {
  private readonly fx = new StaticFxProvider();

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
  ) {}

  async search(ctx: RequestContext, input: unknown): Promise<SearchResponse> {
    const started = Date.now();
    const req: SearchRequestInput = SearchRequestSchema.parse(input);
    const nights = nightsBetween(req.checkIn, req.checkOut);
    const stayDates = dateRange(req.checkIn, req.checkOut).slice(0, nights);

    if (nights < 1 || nights > 30) {
      throw new DomainError({
        code: 'VALIDATION',
        message: 'Stays must be between 1 and 30 nights',
        owner: 'Commerce',
      });
    }

    const properties = await this.candidateProperties(ctx, req);
    const offers: HotelOffer[] = [];
    const excluded: SearchResponse['excluded'] = [];
    const impressions: any[] = [];

    const buyer = await clients.coreCommerce
      .get<any[]>('/internal/core/organizations', ctx)
      .then((orgs) => orgs.find((o) => o.id === ctx.organizationId))
      .catch(() => null);
    const buyerType = buyer?.type ?? 'AGENCY';

    const searchRow = await this.prisma.searchRequest.create({
      data: {
        tenantId: ctx.tenantId,
        buyerOrgId: ctx.organizationId,
        destination: req.destination ?? null,
        propertyIds: req.propertyIds,
        checkIn: new Date(`${req.checkIn}T00:00:00.000Z`),
        checkOut: new Date(`${req.checkOut}T00:00:00.000Z`),
        rooms: req.rooms,
        adults: req.adults,
        children: req.children,
        market: req.market,
        currency: req.currency,
        correlationId: ctx.correlationId,
      },
    });

    for (const property of properties) {
      let built: { offers: HotelOffer[]; reason: string; predicates: string[] } = {
        offers: [],
        reason: 'not evaluated',
        predicates: [],
      };

      try {
        // Distribution is evaluated FIRST, before any contract or pricing work.
        // A hotel closed to this market must never reach the point of having a
        // rate computed for it — that is both wasted work and the exact way a
        // rate leaks into a channel the hotel excluded.
        const distribution = await clients.coreCommerce.post<DistributionDecision>(
          `/internal/core/properties/${property.id}/distribution/evaluate`,
          ctx,
          {
            organizationId: ctx.organizationId,
            organizationType: buyerType,
            market: req.market,
            channel: req.channel,
            checkIn: req.checkIn,
            nights: stayDates.length,
          },
        );

        if (!distribution.allowed) {
          built = {
            offers: [],
            reason: distribution.reason ?? 'Not distributed to this buyer.',
            predicates: distribution.deniedBy.map((d) => `DISTRIBUTION_${d}`),
          };
        } else {
          built = await this.offersForProperty(ctx, req, property, stayDates, searchRow.id);
        }

        offers.push(...built.offers);
        if (built.offers.length === 0) {
          excluded.push({
            propertyId: property.id,
            propertyName: property.name,
            reason: built.reason,
            predicates: built.predicates,
          });
        }
      } catch (err) {
        built = {
          offers: [],
          reason: err instanceof DomainError ? err.message : 'internal error building offers',
          predicates: [],
        };
        excluded.push({
          propertyId: property.id,
          propertyName: property.name,
          reason: built.reason,
          predicates: built.predicates,
        });
      }

      // One impression per property per search, whatever the outcome. This is
      // the row that turns "2,400 searches" into "this buyer looked at YOUR
      // hotel 2,400 times and we could not quote 1,900 of them".
      impressions.push({
        tenantId: ctx.tenantId,
        searchId: searchRow.id,
        propertyId: property.id,
        buyerOrgId: ctx.organizationId,
        sourceMarket: req.market,
        destinationCountry: property.country,
        destinationCity: property.city,
        checkIn: new Date(`${req.checkIn}T00:00:00.000Z`),
        nights: stayDates.length,
        adults: req.adults,
        rooms: req.rooms,
        offered: built.offers.length > 0,
        offerCount: built.offers.length,
        lowestRate: built.offers.length
          ? Math.min(...built.offers.map((o) => o.price.money.supplierAmount))
          : null,
        currency: built.offers[0]?.price.money.supplierCurrency ?? null,
        blockedBy: built.predicates,
      });
    }

    if (impressions.length) {
      // Analytics must never be able to fail a search. A buyer losing a result
      // set because a metrics insert deadlocked is an unacceptable trade.
      await this.prisma.searchImpression
        .createMany({ data: impressions })
        .catch(() => undefined);
    }

    offers.sort((a, b) => a.price.money.buyerAmount - b.price.money.buyerAmount);

    const latencyMs = Date.now() - started;
    await this.prisma.searchRequest.update({
      where: { id: searchRow.id },
      data: { resultCount: offers.length, latencyMs },
    });

    metrics.observe(M.searchLatency, latencyMs);
    metrics.inc(M.searchOffers, {}, offers.length);
    metrics.inc(M.searchExcluded, {}, excluded.length);

    await this.bus.publish(
      'SearchExecuted',
      { searchId: searchRow.id, offers: offers.length, excluded: excluded.length, latencyMs },
      { tenantId: ctx.tenantId, partitionKey: ctx.organizationId, correlationId: ctx.correlationId },
    );

    return { searchId: searchRow.id, correlationId: ctx.correlationId, latencyMs, offers, excluded };
  }

  private async candidateProperties(
    ctx: RequestContext,
    req: SearchRequestInput,
  ): Promise<PropertyRef[]> {
    const all = await clients.coreCommerce.get<PropertyRef[]>('/internal/core/properties', ctx);
    return all.filter((p) => {
      if (req.propertyIds.length) return req.propertyIds.includes(p.id);
      if (req.destination)
        return p.city.toLowerCase().includes(req.destination.toLowerCase());
      return true;
    });
  }

  private async offersForProperty(
    ctx: RequestContext,
    req: SearchRequestInput,
    property: PropertyRef,
    stayDates: StayDate[],
    searchId: string,
  ): Promise<{ offers: HotelOffer[]; reason: string; predicates: string[] }> {
    const today = toStayDate(new Date());

    const [catalog, contract, promotions, cells] = await Promise.all([
      clients.coreCommerce.get<{
        property: PropertyRef;
        roomTypes: RoomTypeRef[];
        ratePlans: RatePlanRef[];
        taxes: TaxRuleRef[];
      }>(`/internal/core/properties/${property.id}/catalog`, ctx),
      clients.coreCommerce.post<ContractRef | null>('/internal/core/contracts/resolve', ctx, {
        buyerOrgId: ctx.organizationId,
        propertyId: property.id,
        market: req.market,
        channel: req.channel,
        on: today,
      }),
      clients.coreCommerce.get<PromotionRef[]>(
        `/internal/core/promotions?propertyId=${property.id}&activeOn=${today}`,
        ctx,
      ),
      clients.ari.get<EffectiveAriRow[]>(
        `/internal/ari/effective?propertyId=${property.id}&from=${stayDates[0]}&to=${stayDates[stayDates.length - 1]}`,
        ctx,
      ),
    ]);

    const mappingActive = cells.length > 0;
    const offers: HotelOffer[] = [];
    const failedPredicates = new Set<string>();

    for (const room of catalog.roomTypes.filter((r) => r.active)) {
      if (room.maxAdults < req.adults) continue;

      for (const plan of catalog.ratePlans.filter((p) => p.active)) {
        const perNight: number[] = [];
        let blocked: string | null = null;

        for (const [i, stayDate] of stayDates.entries()) {
          const cell = cells.find(
            (c) => c.roomTypeId === room.id && c.ratePlanId === plan.id && c.stayDate === stayDate,
          );

          const sell = evaluateSellability(cell ?? null, {
            now: new Date(),
            freshnessSlaSeconds: Number(process.env.ARI_FRESHNESS_SLA_SECONDS ?? 3600),
            propertyStatus: property.status,
            mappingActive,
            contract: contract
              ? {
                  id: contract.id,
                  status: contract.status,
                  validFrom: contract.validFrom,
                  validTo: contract.validTo,
                  markets: contract.markets,
                  channels: contract.channels,
                  propertyIds: contract.propertyIds,
                }
              : null,
            buyer: {
              organizationId: ctx.organizationId,
              market: req.market,
              channel: req.channel,
            },
            stay: {
              checkIn: req.checkIn,
              checkOut: req.checkOut,
              nights: stayDates.length,
              isArrival: i === 0,
              isDeparture: i === stayDates.length - 1,
            },
          });

          if (!sell.sellable) {
            sell.failedCodes.forEach((c) => failedPredicates.add(c));
            blocked = `${stayDate}: ${sell.failedCodes.join(', ')}`;
            break;
          }
          // Availability is checked per night against the number of rooms
          // requested, not just against "greater than zero".
          if ((cell?.available ?? 0) < req.rooms) {
            failedPredicates.add('AVAILABILITY_POSITIVE');
            blocked = `${stayDate}: only ${cell?.available ?? 0} room(s) for a request of ${req.rooms}`;
            break;
          }
          perNight.push(cell!.baseAmount!);
        }

        if (blocked || perNight.length !== stayDates.length) continue;

        const firstCell = cells.find((c) => c.roomTypeId === room.id && c.ratePlanId === plan.id)!;
        const supplierCurrency = firstCell.currency ?? plan.currency ?? property.currency;

        const promoCtx: PromotionContext = {
          now: new Date(),
          bookingDate: today,
          checkIn: req.checkIn,
          checkOut: req.checkOut,
          nights: stayDates.length,
          stayDates,
          adults: req.adults,
          children: req.children,
          roomTypeCode: room.code,
          ratePlanCode: plan.code,
          propertyId: property.id,
          buyer: {
            organizationId: ctx.organizationId,
            market: req.market,
            channel: req.channel,
          },
          promoCode: req.promoCode ?? null,
          perNight,
        };

        const price = buildPriceBreakdown({
          stayDates,
          perNightBase: perNight,
          supplierCurrency,
          buyerCurrency: req.currency,
          normalizationCurrency: process.env.FX_NORMALIZATION_CURRENCY ?? 'USD',
          adults: req.adults,
          children: req.children,
          occupancyPrices: null,
          promotions,
          promotionContext: promoCtx,
          contract,
          taxes: catalog.taxes,
          fx: this.fx,
          at: new Date(),
        });

        const offer = await this.persistOffer(ctx, {
          searchId,
          req,
          property,
          room,
          plan,
          stayDates,
          price,
          contract,
          freshness: firstCell.freshnessSeconds,
          ariSource: Object.values(firstCell.explanation?.fields ?? {})[0]?.source ?? 'unknown',
          ariLayers: firstCell.explanation?.layersPresent ?? [],
          sellability: evaluateSellability(firstCell, {
            now: new Date(),
            freshnessSlaSeconds: Number(process.env.ARI_FRESHNESS_SLA_SECONDS ?? 3600),
            propertyStatus: property.status,
            mappingActive,
            contract: contract
              ? {
                  id: contract.id,
                  status: contract.status,
                  validFrom: contract.validFrom,
                  validTo: contract.validTo,
                  markets: contract.markets,
                  channels: contract.channels,
                  propertyIds: contract.propertyIds,
                }
              : null,
            buyer: { organizationId: ctx.organizationId, market: req.market, channel: req.channel },
            stay: {
              checkIn: req.checkIn,
              checkOut: req.checkOut,
              nights: stayDates.length,
              isArrival: true,
              isDeparture: false,
            },
          }),
        });

        offers.push(offer);
      }
    }

    return {
      offers,
      reason: offers.length
        ? 'ok'
        : failedPredicates.size
          ? `Blocked by: ${[...failedPredicates].join(', ')}`
          : 'No room/rate combination produced a complete stay for the requested dates',
      predicates: [...failedPredicates],
    };
  }

  private async persistOffer(
    ctx: RequestContext,
    args: any,
  ): Promise<HotelOffer> {
    const ttl = Number(process.env.OFFER_TTL_SECONDS ?? 900);
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const secret = process.env.OFFER_SIGNING_SECRET ?? 'change-me-in-production';

    const row = await this.prisma.offer.create({
      data: {
        tenantId: ctx.tenantId,
        searchId: args.searchId,
        buyerOrgId: ctx.organizationId,
        propertyId: args.property.id,
        roomTypeId: args.room.id,
        ratePlanId: args.plan.id,
        checkIn: new Date(`${args.req.checkIn}T00:00:00.000Z`),
        checkOut: new Date(`${args.req.checkOut}T00:00:00.000Z`),
        nights: args.stayDates.length,
        adults: args.req.adults,
        children: args.req.children,
        supplierCurrency: args.price.money.supplierCurrency,
        supplierAmount: args.price.money.supplierAmount,
        normalizedCurrency: args.price.money.normalizedCurrency,
        normalizedAmount: args.price.money.normalizedAmount,
        fxRate: args.price.money.fx.rate,
        fxSource: args.price.money.fx.source,
        fxTimestamp: new Date(args.price.money.fx.timestamp),
        buyerCurrency: args.price.money.buyerCurrency,
        buyerAmount: args.price.money.buyerAmount,
        netAmount: args.price.netAmount,
        taxAmount: args.price.taxAmount,
        feeAmount: args.price.feeAmount,
        commissionAmount: args.price.commissionAmount,
        grossAmount: args.price.grossAmount,
        promotionIds: args.price.promotions.filter((p: any) => p.applied).map((p: any) => p.promotionId),
        contractId: args.contract?.id ?? null,
        mealPlan: args.plan.mealPlan,
        cancellation: (args.contract?.cancellationPolicy ?? null) as any,
        provenance: {
          ariSource: args.ariSource,
          ariLayers: args.ariLayers,
          freshnessSeconds: args.freshness,
          contractVersion: args.contract?.version ?? null,
          computedAt: new Date().toISOString(),
        } as any,
        explanation: { steps: args.price.steps, promotions: args.price.promotions } as any,
        signature: 'pending',
        expiresAt: new Date(expiresAt),
      },
    });

    // Signing happens after insert so the offer id — the thing a caller could
    // swap — is inside the signed payload.
    const signature = signOffer(
      {
        offerId: row.id,
        propertyId: args.property.id,
        roomTypeId: args.room.id,
        ratePlanId: args.plan.id,
        checkIn: args.req.checkIn,
        checkOut: args.req.checkOut,
        adults: args.req.adults,
        children: args.req.children,
        buyerOrgId: ctx.organizationId,
        buyerCurrency: args.price.money.buyerCurrency,
        buyerAmount: args.price.money.buyerAmount,
        contractId: args.contract?.id ?? null,
        promotionIds: row.promotionIds,
        expiresAt,
        version: 1,
      },
      secret,
    );
    await this.prisma.offer.update({ where: { id: row.id }, data: { signature } });

    return {
      offerId: row.id,
      propertyId: args.property.id,
      propertyName: args.property.name,
      propertyCity: args.property.city,
      propertyCountry: args.property.country,
      roomTypeId: args.room.id,
      roomTypeCode: args.room.code,
      roomTypeName: args.room.name,
      ratePlanId: args.plan.id,
      ratePlanCode: args.plan.code,
      ratePlanName: args.plan.name,
      mealPlan: args.plan.mealPlan,
      checkIn: args.req.checkIn,
      checkOut: args.req.checkOut,
      nights: args.stayDates.length,
      adults: args.req.adults,
      children: args.req.children,
      price: args.price,
      cancellation: args.contract?.cancellationPolicy ?? null,
      contractId: args.contract?.id ?? null,
      promotionIds: row.promotionIds,
      provenance: {
        ariSource: args.ariSource,
        ariLayers: args.ariLayers,
        freshnessSeconds: args.freshness,
        mappingVersion: null,
        contractVersion: args.contract?.version ?? null,
        computedAt: new Date().toISOString(),
      },
      sellability: args.sellability,
      signature,
      expiresAt,
      version: 1,
    };
  }
}
