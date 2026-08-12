import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { AriValues, EffectiveAriRow, StayDate, dateRange } from '@wetriip/contracts';
import { LayerInput, computeEffectiveAri } from '@wetriip/domain';
import { toNumber, toStayDateString } from '@wetriip/persistence';
import { M, metrics } from '@wetriip/observability';
import { PRISMA, RequestContext } from '@wetriip/service-kit';

/**
 * Effective ARI materializer and read model.
 *
 * Materialized rather than computed on read: search has an 800ms p95 budget and
 * cannot afford to merge layers per request. The trade is staleness, which we
 * bound by recomputing synchronously on every accepted event.
 *
 * Recomputation is idempotent by construction — it is a pure function of the
 * layer rows — so a replay, a backfill and a live event all converge on the
 * same result.
 */
@Injectable()
export class EffectiveAriService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  private get slaSeconds(): number {
    return Number(process.env.ARI_FRESHNESS_SLA_SECONDS ?? 3600);
  }

  async recompute(
    tenantId: string,
    args: {
      propertyId: string;
      roomTypeId: string;
      ratePlanId: string;
      stayDates: StayDate[];
      occupancy: number;
    },
  ): Promise<number> {
    const started = Date.now();
    const dates = args.stayDates.map((d) => new Date(`${d}T00:00:00.000Z`));

    const cells = await this.prisma.ariCell.findMany({
      where: {
        tenantId,
        propertyId: args.propertyId,
        roomTypeId: args.roomTypeId,
        ratePlanId: args.ratePlanId,
        occupancy: args.occupancy,
        stayDate: { in: dates },
      },
    });

    const byDate = new Map<string, { EXTERNAL?: any; MANAGED?: any }>();
    for (const c of cells) {
      const d = toStayDateString(c.stayDate);
      const e = byDate.get(d) ?? {};
      (e as any)[c.layer] = c;
      byDate.set(d, e);
    }

    const now = new Date();
    let written = 0;

    for (const stayDate of args.stayDates) {
      const layers = byDate.get(stayDate) ?? {};
      const row = computeEffectiveAri({
        key: {
          tenantId,
          propertyId: args.propertyId,
          roomTypeId: args.roomTypeId,
          ratePlanId: args.ratePlanId,
          stayDate,
          occupancy: args.occupancy,
        },
        external: layers.EXTERNAL ? toLayerInput(layers.EXTERNAL) : null,
        managed: layers.MANAGED ? toLayerInput(layers.MANAGED) : null,
        now,
        freshnessSlaSeconds: this.slaSeconds,
      });

      await this.prisma.effectiveAri.upsert({
        where: {
          tenantId_propertyId_roomTypeId_ratePlanId_stayDate_occupancy: {
            tenantId,
            propertyId: args.propertyId,
            roomTypeId: args.roomTypeId,
            ratePlanId: args.ratePlanId,
            stayDate: new Date(`${stayDate}T00:00:00.000Z`),
            occupancy: args.occupancy,
          },
        } as any,
        create: {
          tenantId,
          propertyId: args.propertyId,
          roomTypeId: args.roomTypeId,
          ratePlanId: args.ratePlanId,
          stayDate: new Date(`${stayDate}T00:00:00.000Z`),
          occupancy: args.occupancy,
          ...toDbRow(row),
        },
        update: { ...toDbRow(row), version: { increment: 1 } },
      });
      written += 1;
    }

    metrics.observe(M.ariMaterializeLatency, Date.now() - started);
    return written;
  }

  async read(
    ctx: RequestContext,
    args: {
      propertyId: string;
      from: StayDate;
      to: StayDate;
      roomTypeIds?: string[];
      ratePlanIds?: string[];
      occupancy?: number;
    },
  ): Promise<EffectiveAriRow[]> {
    const rows = await this.prisma.effectiveAri.findMany({
      where: {
        tenantId: ctx.tenantId,
        propertyId: args.propertyId,
        stayDate: {
          gte: new Date(`${args.from}T00:00:00.000Z`),
          lte: new Date(`${args.to}T00:00:00.000Z`),
        },
        ...(args.roomTypeIds?.length ? { roomTypeId: { in: args.roomTypeIds } } : {}),
        ...(args.ratePlanIds?.length ? { ratePlanId: { in: args.ratePlanIds } } : {}),
        ...(args.occupancy ? { occupancy: args.occupancy } : {}),
      },
      orderBy: [{ stayDate: 'asc' }, { roomTypeId: 'asc' }],
      take: 20_000,
    });

    // Freshness is a function of NOW, not of when the row was written, so it is
    // recomputed on read. A row materialized an hour ago is an hour staler than
    // its stored value claims.
    const now = Date.now();
    return rows.map((r) => {
      const row = fromDbRow(r);
      if (row.freshnessSeconds >= 0) {
        const computedAtMs = new Date(r.computedAt).getTime();
        row.freshnessSeconds = row.freshnessSeconds + Math.round((now - computedAtMs) / 1000);
        row.stale = row.freshnessSeconds > this.slaSeconds;
      }
      return row;
    });
  }

  /** Full recompute for a window. Used by reconciliation and by rollback. */
  async recomputeWindow(
    tenantId: string,
    propertyId: string,
    from: StayDate,
    to: StayDate,
  ): Promise<number> {
    const combos = await this.prisma.ariCell.findMany({
      where: {
        tenantId,
        propertyId,
        stayDate: {
          gte: new Date(`${from}T00:00:00.000Z`),
          lte: new Date(`${to}T00:00:00.000Z`),
        },
      },
      distinct: ['roomTypeId', 'ratePlanId', 'occupancy'],
      select: { roomTypeId: true, ratePlanId: true, occupancy: true },
    });

    const dates = dateRange(from, to);
    let total = 0;
    for (const c of combos) {
      total += await this.recompute(tenantId, {
        propertyId,
        roomTypeId: c.roomTypeId,
        ratePlanId: c.ratePlanId,
        stayDates: dates,
        occupancy: c.occupancy,
      });
    }
    return total;
  }
}

function toLayerInput(cell: any): LayerInput {
  const values: AriValues = {
    allotment: cell.allotment,
    available: cell.available,
    sold: cell.sold,
    overbookingLimit: cell.overbookingLimit,
    currency: cell.currency,
    baseAmount: toNumber(cell.baseAmount),
    adultPrices: cell.adultPrices,
    childPrices: cell.childPrices,
    open: cell.open,
    stopSell: cell.stopSell,
    closedToArrival: cell.closedToArrival,
    closedToDeparture: cell.closedToDeparture,
    minLos: cell.minLos,
    maxLos: cell.maxLos,
    releaseDays: cell.releaseDays,
    bookingGap: cell.bookingGap,
  };
  // Strip nulls the layer never actually set, so a null does not masquerade as
  // an explicit clear during the merge.
  for (const k of Object.keys(values) as (keyof AriValues)[]) {
    if (values[k] === null) delete values[k];
  }
  return {
    layer: cell.layer,
    values,
    source: cell.source,
    sourceTimestamp: cell.sourceTimestamp,
    version: cell.version,
    validFrom: cell.validFrom,
    validTo: cell.validTo,
  };
}

function toDbRow(row: EffectiveAriRow) {
  return {
    currency: row.currency,
    baseAmount: row.baseAmount,
    available: row.available,
    open: row.open,
    closedToArrival: row.closedToArrival,
    closedToDeparture: row.closedToDeparture,
    minLos: row.minLos,
    maxLos: row.maxLos,
    releaseDays: row.releaseDays,
    bookingGap: row.bookingGap,
    freshnessSeconds: row.freshnessSeconds < 0 ? 0 : Math.min(row.freshnessSeconds, 2_000_000_000),
    stale: row.stale,
    explanation: row.explanation as any,
    externalVersion: row.externalVersion,
    managedVersion: row.managedVersion,
    computedAt: new Date(row.computedAt),
  };
}

function fromDbRow(r: any): EffectiveAriRow {
  return {
    tenantId: r.tenantId,
    propertyId: r.propertyId,
    roomTypeId: r.roomTypeId,
    ratePlanId: r.ratePlanId,
    stayDate: toStayDateString(r.stayDate),
    occupancy: r.occupancy,
    currency: r.currency,
    baseAmount: toNumber(r.baseAmount),
    available: r.available,
    open: r.open,
    closedToArrival: r.closedToArrival,
    closedToDeparture: r.closedToDeparture,
    minLos: r.minLos,
    maxLos: r.maxLos,
    releaseDays: r.releaseDays,
    bookingGap: r.bookingGap,
    freshnessSeconds: r.freshnessSeconds,
    stale: r.stale,
    explanation: r.explanation,
    externalVersion: r.externalVersion,
    managedVersion: r.managedVersion,
    version: r.version,
    computedAt: r.computedAt.toISOString(),
  };
}
