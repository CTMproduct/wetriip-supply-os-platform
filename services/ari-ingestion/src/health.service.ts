import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { AriHealthRow, StayDate, dateRange } from '@wetriip/contracts';
import { toStayDateString } from '@wetriip/persistence';
import { PRISMA, RequestContext } from '@wetriip/service-kit';

/**
 * ARI Health.
 *
 * The audited platform had this screen with rich columns and no rows, which is
 * the worst possible state: an operator cannot tell "healthy and empty" from
 * "broken and silent". Every metric here is therefore bound to a cause and a
 * timestamp, and a room/rate pair with no data at all reports NO_DATA rather
 * than simply not appearing.
 */
@Injectable()
export class AriHealthService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  private get slaSeconds(): number {
    return Number(process.env.ARI_FRESHNESS_SLA_SECONDS ?? 3600);
  }

  async report(
    ctx: RequestContext,
    args: { propertyId: string; from: StayDate; to: StayDate },
  ): Promise<{ rows: AriHealthRow[]; summary: Record<string, number>; window: { from: string; to: string } }> {
    const expectedDates = dateRange(args.from, args.to);
    const expected = expectedDates.length;
    const now = Date.now();
    const since24h = new Date(now - 86_400_000);

    const [rooms, plans, cells, recentEvents] = await Promise.all([
      this.prisma.roomType.findMany({ where: { propertyId: args.propertyId } }),
      this.prisma.ratePlan.findMany({ where: { propertyId: args.propertyId } }),
      this.prisma.effectiveAri.findMany({
        where: {
          tenantId: ctx.tenantId,
          propertyId: args.propertyId,
          stayDate: {
            gte: new Date(`${args.from}T00:00:00.000Z`),
            lte: new Date(`${args.to}T00:00:00.000Z`),
          },
        },
      }),
      this.prisma.ariEvent.findMany({
        where: { tenantId: ctx.tenantId, propertyId: args.propertyId, receivedAt: { gte: since24h } },
        select: { roomTypeId: true, ratePlanId: true, status: true, source: true, sourceTimestamp: true },
      }),
    ]);

    const rows: AriHealthRow[] = [];

    for (const room of rooms) {
      for (const plan of plans) {
        const mine = cells.filter((c) => c.roomTypeId === room.id && c.ratePlanId === plan.id);
        const events = recentEvents.filter((e) => e.roomTypeId === room.id && e.ratePlanId === plan.id);

        const covered = new Set(mine.map((c) => toStayDateString(c.stayDate)));
        const gaps = expectedDates.filter((d) => !covered.has(d));

        const lastEvent = events
          .map((e) => e.sourceTimestamp)
          .sort((a, b) => b.getTime() - a.getTime())[0];
        const freshnessSeconds = lastEvent ? Math.round((now - lastEvent.getTime()) / 1000) : null;

        const staleDates = mine.filter((c) => {
          const age = c.freshnessSeconds + Math.round((now - new Date(c.computedAt).getTime()) / 1000);
          return age > this.slaSeconds;
        }).length;

        const closedDates = mine.filter((c) => !c.open).length;
        const zeroAvail = mine.filter((c) => c.available <= 0).length;
        const losValues = mine.map((c) => c.minLos).filter((n) => n != null) as number[];

        const causes: string[] = [];
        let status: AriHealthRow['status'] = 'HEALTHY';

        if (mine.length === 0) {
          status = 'NO_DATA';
          causes.push(
            events.length === 0
              ? 'No ARI event has ever been received for this room/rate combination.'
              : `${events.length} event(s) received in 24h but none materialized — check mapping and rejections.`,
          );
        } else {
          if (gaps.length > 0) {
            status = 'DEGRADED';
            causes.push(`${gaps.length} date(s) with no inventory data in the requested window.`);
          }
          if (freshnessSeconds != null && freshnessSeconds > this.slaSeconds) {
            status = 'BROKEN';
            causes.push(
              `Last event ${Math.round(freshnessSeconds / 3600)}h ago, beyond the ${Math.round(this.slaSeconds / 3600)}h SLA.`,
            );
          }
          if (staleDates > 0 && status === 'HEALTHY') {
            status = 'DEGRADED';
            causes.push(`${staleDates} date(s) past the freshness SLA.`);
          }
          if (zeroAvail === mine.length && mine.length > 0) {
            status = status === 'HEALTHY' ? 'DEGRADED' : status;
            causes.push('Every date in the window has zero availability.');
          }
        }

        rows.push({
          roomTypeId: room.id,
          roomTypeCode: room.code,
          ratePlanId: plan.id,
          ratePlanCode: plan.code,
          datesCovered: covered.size,
          datesExpected: expected,
          coveragePct: expected ? Math.round((covered.size / expected) * 1000) / 10 : 0,
          gaps: gaps.slice(0, 40),
          freshnessSeconds,
          lastEventAt: lastEvent ? lastEvent.toISOString() : null,
          lastSource: events[0]?.source ?? null,
          staleDates,
          closedDates,
          zeroAvailabilityDates: zeroAvail,
          avgMinLos: losValues.length
            ? Math.round((losValues.reduce((s, n) => s + n, 0) / losValues.length) * 10) / 10
            : null,
          maxMaxLos: mine.reduce<number | null>((m, c) => (c.maxLos != null && (m == null || c.maxLos > m) ? c.maxLos : m), null),
          rejectedLast24h: events.filter((e) => e.status === 'REJECTED').length,
          outOfOrderLast24h: events.filter((e) => e.status === 'OUT_OF_ORDER').length,
          status,
          causes,
        });
      }
    }

    return {
      rows,
      window: { from: args.from, to: args.to },
      summary: {
        combinations: rows.length,
        healthy: rows.filter((r) => r.status === 'HEALTHY').length,
        degraded: rows.filter((r) => r.status === 'DEGRADED').length,
        broken: rows.filter((r) => r.status === 'BROKEN').length,
        noData: rows.filter((r) => r.status === 'NO_DATA').length,
      },
    };
  }

  /** Raw ledger, newest first. The evidence trail an operator pastes into a
   *  ticket when a channel manager disputes what it sent. */
  async ledger(
    ctx: RequestContext,
    args: { propertyId: string; limit?: number; stayDate?: string; status?: string },
  ) {
    const rows = await this.prisma.ariEvent.findMany({
      where: {
        tenantId: ctx.tenantId,
        propertyId: args.propertyId,
        ...(args.stayDate ? { stayDate: new Date(`${args.stayDate}T00:00:00.000Z`) } : {}),
        ...(args.status ? { status: args.status as any } : {}),
      },
      orderBy: { id: 'desc' },
      take: Math.min(args.limit ?? 100, 500),
    });
    return rows.map((r) => ({
      id: r.id.toString(),
      stayDate: toStayDateString(r.stayDate),
      roomTypeId: r.roomTypeId,
      ratePlanId: r.ratePlanId,
      layer: r.layer,
      eventType: r.eventType,
      source: r.source,
      sourceSequence: r.sourceSequence?.toString() ?? null,
      status: r.status,
      rejectReason: r.rejectReason,
      before: r.before,
      after: r.after,
      sourceTimestamp: r.sourceTimestamp.toISOString(),
      receivedAt: r.receivedAt.toISOString(),
      correlationId: r.correlationId,
      actorType: r.actorType,
      actorId: r.actorId,
      reason: r.reason,
      payloadHash: r.payloadHash,
    }));
  }
}
