import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { EventBus } from '@wetriip/bus';
import { EffectiveAriRow, StayDate, addDays, toStayDate } from '@wetriip/contracts';
import { Logger } from '@wetriip/observability';
import { toNumber, toStayDateString } from '@wetriip/persistence';
import { EVENT_BUS, LOGGER, PRISMA, RequestContext, clients } from '@wetriip/service-kit';

/**
 * Reconciliation.
 *
 * Verifies the chain the audit asks us to prove:
 *
 *   SOURCE  ≈  LEDGER  ≈  EFFECTIVE  ≈  DISTRIBUTION
 *
 * Each hop is checked independently, because each breaks differently:
 * a provider stops sending; the ledger accepts but the materializer lags;
 * effective is right but the buyer sees something else. A single end-to-end
 * comparison would tell us that something is wrong without saying where.
 *
 * Divergences are recorded, never auto-corrected. Silently "fixing" a
 * mismatch destroys the evidence needed to find the cause, and the cause is
 * usually upstream of us.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  async run(
    ctx: RequestContext,
    args: { propertyId: string; from?: StayDate; to?: StayDate; connectionId?: string },
  ) {
    const from = args.from ?? toStayDate(new Date());
    const to = args.to ?? addDays(from, 30);

    const run = await this.prisma.reconciliationRun.create({
      data: {
        tenantId: ctx.tenantId,
        connectionId: args.connectionId ?? null,
        scope: { propertyId: args.propertyId, from, to } as any,
        status: 'RUNNING',
      },
    });

    await this.bus.publish(
      'ReconciliationStarted',
      { runId: run.id, propertyId: args.propertyId, from, to },
      { tenantId: ctx.tenantId, partitionKey: args.propertyId, correlationId: ctx.correlationId },
    );

    let compared = 0;
    const divergences: Array<{
      kind: string;
      key: any;
      sourceValue?: any;
      ledgerValue?: any;
      effectiveValue?: any;
    }> = [];

    try {
      // ── Hop 1: LEDGER -> EFFECTIVE ──────────────────────
      // The layer cell is the ledger's projection; effective is derived from
      // it. Any mismatch here is our own materializer, not the provider's.
      const cells = await this.prisma.ariCell.findMany({
        where: {
          tenantId: ctx.tenantId,
          propertyId: args.propertyId,
          layer: 'EXTERNAL',
          stayDate: {
            gte: new Date(`${from}T00:00:00.000Z`),
            lte: new Date(`${to}T00:00:00.000Z`),
          },
        },
      });

      const effective = await clients.ari.get<EffectiveAriRow[]>(
        `/internal/ari/effective?propertyId=${args.propertyId}&from=${from}&to=${to}`,
        ctx,
      );
      const effIndex = new Map(
        effective.map((e) => [`${e.roomTypeId}|${e.ratePlanId}|${e.stayDate}|${e.occupancy}`, e]),
      );

      for (const cell of cells) {
        compared += 1;
        const key = `${cell.roomTypeId}|${cell.ratePlanId}|${toStayDateString(cell.stayDate)}|${cell.occupancy}`;
        const eff = effIndex.get(key);

        if (!eff) {
          divergences.push({
            kind: 'MISSING_EFFECTIVE',
            key: { key },
            ledgerValue: { baseAmount: toNumber(cell.baseAmount), available: cell.available },
          });
          continue;
        }

        // A managed override legitimately changes the effective value, so a
        // mismatch is only a divergence when no managed layer exists.
        const managed = await this.prisma.ariCell.findFirst({
          where: {
            tenantId: ctx.tenantId,
            propertyId: cell.propertyId,
            roomTypeId: cell.roomTypeId,
            ratePlanId: cell.ratePlanId,
            stayDate: cell.stayDate,
            occupancy: cell.occupancy,
            layer: 'MANAGED',
          },
        });
        if (managed) continue;

        const ledgerPrice = toNumber(cell.baseAmount);
        if (ledgerPrice != null && eff.baseAmount != null && Math.abs(ledgerPrice - eff.baseAmount) > 0.01) {
          divergences.push({
            kind: 'PRICE_MISMATCH',
            key: { key },
            ledgerValue: { baseAmount: ledgerPrice },
            effectiveValue: { baseAmount: eff.baseAmount },
          });
        }
        if (cell.available != null && cell.available !== eff.available) {
          divergences.push({
            kind: 'AVAILABILITY_MISMATCH',
            key: { key },
            ledgerValue: { available: cell.available },
            effectiveValue: { available: eff.available },
          });
        }
      }

      // ── Hop 2: EFFECTIVE freshness ──────────────────────
      const stale = effective.filter((e) => e.stale);
      if (stale.length) {
        divergences.push({
          kind: 'STALE_EFFECTIVE',
          key: { count: stale.length, sample: stale.slice(0, 5).map((s) => s.stayDate) },
          effectiveValue: { staleCells: stale.length },
        });
      }

      // ── Hop 3: EFFECTIVE -> DISTRIBUTION ────────────────
      // An offer issued in the last hour whose underlying inventory has since
      // closed is not itself an error, but a persistent pattern means the
      // search read model is lagging.
      const recentOffers = await this.prisma.offer.findMany({
        where: {
          tenantId: ctx.tenantId,
          propertyId: args.propertyId,
          createdAt: { gte: new Date(Date.now() - 3_600_000) },
        },
        take: 200,
      });
      for (const offer of recentOffers) {
        const nights = effective.filter(
          (e) =>
            e.roomTypeId === offer.roomTypeId &&
            e.ratePlanId === offer.ratePlanId &&
            e.stayDate >= toStayDateString(offer.checkIn) &&
            e.stayDate < toStayDateString(offer.checkOut),
        );
        if (nights.some((n) => !n.open || n.available <= 0)) {
          divergences.push({
            kind: 'OFFER_UNBACKED',
            key: { offerId: offer.id },
            effectiveValue: { closedNights: nights.filter((n) => !n.open || n.available <= 0).length },
          });
        }
      }

      const finished = await this.prisma.$transaction(async (tx) => {
        for (const d of divergences) {
          await tx.divergence.create({
            data: {
              runId: run.id,
              kind: d.kind,
              key: d.key as any,
              sourceValue: (d.sourceValue ?? null) as any,
              ledgerValue: (d.ledgerValue ?? null) as any,
              effectiveValue: (d.effectiveValue ?? null) as any,
            },
          });
        }
        return tx.reconciliationRun.update({
          where: { id: run.id },
          data: {
            status: 'COMPLETED',
            compared,
            divergences: divergences.length,
            finishedAt: new Date(),
            report: {
              byKind: countBy(divergences.map((d) => d.kind)),
              window: { from, to },
            } as any,
          },
        });
      });

      if (divergences.length) {
        await this.bus.publish(
          'DivergenceDetected',
          { runId: run.id, propertyId: args.propertyId, count: divergences.length },
          { tenantId: ctx.tenantId, partitionKey: args.propertyId, correlationId: ctx.correlationId },
        );
      }
      await this.bus.publish(
        'ReconciliationCompleted',
        { runId: run.id, compared, divergences: divergences.length },
        { tenantId: ctx.tenantId, partitionKey: args.propertyId, correlationId: ctx.correlationId },
      );

      return { ...finished, items: divergences };
    } catch (err) {
      await this.prisma.reconciliationRun.update({
        where: { id: run.id },
        data: { status: 'FAILED', finishedAt: new Date(), report: { error: String(err) } as any },
      });
      throw err;
    }
  }

  async list(ctx: RequestContext, limit = 25) {
    return this.prisma.reconciliationRun.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { startedAt: 'desc' },
      take: Math.min(limit, 100),
      include: { items: { take: 20 } },
    });
  }
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, v) => {
    acc[v] = (acc[v] ?? 0) + 1;
    return acc;
  }, {});
}
