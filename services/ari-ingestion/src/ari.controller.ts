import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { AriValues, StayDate, dateRange } from '@wetriip/contracts';
import { SimCell } from '@wetriip/domain';
import { Ctx, PRISMA, RequestContext } from '@wetriip/service-kit';
import { EffectiveAriService } from './effective.service';
import { AriHealthService } from './health.service';
import { IngestionService } from './ingestion.service';

@Controller('internal/ari')
export class AriController {
  constructor(
    private readonly ingestion: IngestionService,
    private readonly effective: EffectiveAriService,
    private readonly health: AriHealthService,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
  ) {}

  @Post('events')
  ingest(
    @Ctx() ctx: RequestContext,
    @Body() body: { events: unknown[]; rawEnvelopeId?: string | null },
  ) {
    return this.ingestion.ingest(ctx, body?.events ?? [], { rawEnvelopeId: body?.rawEnvelopeId });
  }

  @Post('managed')
  managed(
    @Ctx() ctx: RequestContext,
    @Body()
    body: {
      propertyId: string;
      roomTypeId: string;
      ratePlanId: string;
      stayDates: string[];
      occupancy?: number;
      values: AriValues;
      reason: string;
      validFrom?: string | null;
      validTo?: string | null;
      actorType?: 'USER' | 'AGENT';
    },
  ) {
    return this.ingestion.applyManagedOverride(ctx, body);
  }

  @Get('effective')
  effectiveRead(
    @Ctx() ctx: RequestContext,
    @Query('propertyId') propertyId: string,
    @Query('from') from: StayDate,
    @Query('to') to: StayDate,
    @Query('roomTypeIds') roomTypeIds?: string,
    @Query('ratePlanIds') ratePlanIds?: string,
    @Query('occupancy') occupancy?: string,
  ) {
    return this.effective.read(ctx, {
      propertyId,
      from,
      to,
      roomTypeIds: roomTypeIds ? roomTypeIds.split(',') : undefined,
      ratePlanIds: ratePlanIds ? ratePlanIds.split(',') : undefined,
      occupancy: occupancy ? Number(occupancy) : undefined,
    });
  }

  /**
   * Simulation input. The agent's simulation engine is pure and needs the
   * current state of every cell a command would touch; this endpoint resolves
   * the target scope to that exact set, using catalog codes rather than ids so
   * the caller does not have to know internal identifiers.
   */
  @Post('cells-for-target')
  async cellsForTarget(
    @Ctx() ctx: RequestContext,
    @Body()
    body: {
      propertyId: string;
      from: StayDate;
      to: StayDate;
      roomTypeCodes?: string[] | null;
      ratePlanCodes?: string[] | null;
      daysOfWeek?: number[] | null;
      occupancy?: number | null;
    },
  ): Promise<SimCell[]> {
    return this.effectiveCells(ctx, body);
  }

  private async effectiveCells(
    ctx: RequestContext,
    body: {
      propertyId: string;
      from: StayDate;
      to: StayDate;
      roomTypeCodes?: string[] | null;
      ratePlanCodes?: string[] | null;
      daysOfWeek?: number[] | null;
      occupancy?: number | null;
    },
  ): Promise<SimCell[]> {
    const catalog = await this.prisma.property.findFirst({
      where: { id: body.propertyId, tenantId: ctx.tenantId },
      include: { roomTypes: true, ratePlans: true },
    });
    if (!catalog) return [];

    const rooms = catalog.roomTypes.filter(
      (r) => !body.roomTypeCodes?.length || body.roomTypeCodes.includes(r.code),
    );
    const plans = catalog.ratePlans.filter(
      (p) => !body.ratePlanCodes?.length || body.ratePlanCodes.includes(p.code),
    );
    const roomById = new Map(rooms.map((r) => [r.id, r]));
    const planById = new Map(plans.map((p) => [p.id, p]));

    const rows = await this.effective.read(ctx, {
      propertyId: body.propertyId,
      from: body.from,
      to: body.to,
      roomTypeIds: rooms.map((r) => r.id),
      ratePlanIds: plans.map((p) => p.id),
      occupancy: body.occupancy ?? undefined,
    });

    const allowedDates = new Set(
      dateRange(body.from, body.to).filter((d) => {
        if (!body.daysOfWeek?.length) return true;
        return body.daysOfWeek.includes(new Date(`${d}T00:00:00.000Z`).getUTCDay());
      }),
    );

    return rows
      .filter((r) => allowedDates.has(r.stayDate))
      .map((r) => ({
        stayDate: r.stayDate,
        roomTypeId: r.roomTypeId,
        roomTypeCode: roomById.get(r.roomTypeId)?.code ?? r.roomTypeId,
        ratePlanId: r.ratePlanId,
        ratePlanCode: planById.get(r.ratePlanId)?.code ?? r.ratePlanId,
        occupancy: r.occupancy,
        currency: r.currency,
        baseAmount: r.baseAmount,
        available: r.available,
        open: r.open,
        closedToArrival: r.closedToArrival,
        closedToDeparture: r.closedToDeparture,
        minLos: r.minLos,
        maxLos: r.maxLos,
        releaseDays: r.releaseDays,
      }));
  }

  @Get('health-report')
  healthReport(
    @Ctx() ctx: RequestContext,
    @Query('propertyId') propertyId: string,
    @Query('from') from: StayDate,
    @Query('to') to: StayDate,
  ) {
    return this.health.report(ctx, { propertyId, from, to });
  }

  @Get('ledger')
  ledger(
    @Ctx() ctx: RequestContext,
    @Query('propertyId') propertyId: string,
    @Query('limit') limit?: string,
    @Query('stayDate') stayDate?: string,
    @Query('status') status?: string,
  ) {
    return this.health.ledger(ctx, {
      propertyId,
      limit: limit ? Number(limit) : undefined,
      stayDate,
      status,
    });
  }

  @Post('recompute')
  recompute(
    @Ctx() ctx: RequestContext,
    @Body() body: { propertyId: string; from: StayDate; to: StayDate },
  ) {
    return this.effective
      .recomputeWindow(ctx.tenantId, body.propertyId, body.from, body.to)
      .then((n) => ({ recomputed: n }));
  }
}
