import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import {
  ConnectionHealthSnapshot,
  ContractRef,
  DiagnosticReport,
  EffectiveAriRow,
  PropertyRef,
  StayDate,
  addDays,
  toStayDate,
} from '@wetriip/contracts';
import { diagnose } from '@wetriip/domain';
import { PRISMA, RequestContext, clients } from '@wetriip/service-kit';

/**
 * "Why am I not selling?"
 *
 * The answer has to separate two failures that look identical from a hotel's
 * chair: the technical one (nobody can see you) and the commercial one
 * (everybody can see you and nobody wants your price). This service gathers
 * evidence from every plane and hands it to the pure diagnostic engine.
 *
 * The competitive set is derived from the platform's own inventory in the same
 * city and window. That is a proxy, and it is labelled as one — a real rate
 * shopper is a later integration, and pretending otherwise would put a
 * confident number behind a guess.
 */
@Injectable()
export class DiagnosticsService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async run(
    ctx: RequestContext,
    args: { propertyId: string; from?: StayDate | null; to?: StayDate | null; market?: string | null },
  ): Promise<DiagnosticReport & { compSetBasis: string }> {
    const from = args.from ?? toStayDate(new Date());
    const to = args.to ?? addDays(from, 30);

    const [property, cells, connections, contracts] = await Promise.all([
      clients.coreCommerce.get<PropertyRef>(`/internal/core/properties/${args.propertyId}`, ctx),
      clients.ari.get<EffectiveAriRow[]>(
        `/internal/ari/effective?propertyId=${args.propertyId}&from=${from}&to=${to}`,
        ctx,
      ),
      clients.connectivity.get<ConnectionHealthSnapshot[]>(
        `/internal/connectivity/health?propertyId=${args.propertyId}`,
        ctx,
      ),
      clients.coreCommerce.get<ContractRef[]>(
        `/internal/core/contracts?propertyId=${args.propertyId}`,
        ctx,
      ),
    ]);

    const [searchCount, bookingCount, compSet] = await Promise.all([
      this.prisma.searchRequest.count({
        where: {
          tenantId: ctx.tenantId,
          createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
          OR: [{ propertyIds: { has: args.propertyId } }, { destination: property.city }],
        },
      }),
      this.prisma.offer
        .count({
          where: {
            tenantId: ctx.tenantId,
            propertyId: args.propertyId,
            createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
          },
        })
        .then(async () =>
          clients.booking
            .get<{ count: number }>(
              `/internal/booking/count?propertyId=${args.propertyId}&sinceDays=30`,
              ctx,
            )
            .then((r) => r.count)
            .catch(() => 0),
        ),
      this.competitiveMedian(ctx, property.city, from, to, args.propertyId),
    ]);

    const mappingActive = connections.some((c) => c.mappingVersion != null);
    const blockedBuyers = contracts
      .filter((c) => c.status === 'SUSPENDED' || c.status === 'EXPIRED')
      .map((c) => ({
        organizationId: c.buyerOrgId,
        name: c.name,
        reason: `Contract ${c.code} is ${c.status}.`,
      }));

    const report = diagnose({
      now: new Date(),
      property: {
        id: property.id,
        name: property.name,
        status: property.status,
        currency: property.currency,
      },
      window: { from, to },
      cells,
      mappingActive,
      mappingVersion: connections.find((c) => c.mappingVersion != null)?.mappingVersion ?? null,
      connections: connections.map((c) => ({
        id: c.connectionId,
        provider: c.provider,
        status: c.status,
        lastEventAt: c.lastEventAt ? new Date(c.lastEventAt) : null,
        displayName: `${c.provider}`,
      })),
      contracts: contracts.map((c) => ({
        id: c.id,
        code: c.code,
        buyerOrgId: c.buyerOrgId,
        status: c.status,
        markets: c.markets,
      })),
      searchCount,
      bookingCount,
      compSetMedian: compSet.median,
      freshnessSlaSeconds: Number(process.env.ARI_FRESHNESS_SLA_SECONDS ?? 3600),
      blockedBuyers,
    });

    return { ...report, compSetBasis: compSet.basis };
  }

  private async competitiveMedian(
    ctx: RequestContext,
    city: string,
    from: StayDate,
    to: StayDate,
    excludePropertyId: string,
  ): Promise<{ median: number | null; basis: string }> {
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
        median: null,
        basis: `Not enough comparable inventory in ${city} (${peers.length} data points). No competitive judgement made.`,
      };
    }
    const values = peers.map((p) => Number(p.baseAmount)).sort((a, b) => a - b);
    return {
      median: values[Math.floor(values.length / 2)],
      basis: `Median open rate across ${values.length} peer inventory cells in ${city} on this platform. Proxy for a comp set, not a rate-shopper feed.`,
    };
  }
}
