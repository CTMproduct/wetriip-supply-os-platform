import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Ctx, RequestContext } from '@wetriip/service-kit';
import { BookingService } from './booking.service';

@Controller('internal/booking')
export class BookingController {
  constructor(private readonly bookings: BookingService) {}

  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.bookings.create(ctx, body);
  }

  @Get('count')
  count(
    @Ctx() ctx: RequestContext,
    @Query('propertyId') propertyId: string,
    @Query('sinceDays') sinceDays?: string,
  ) {
    return this.bookings.count(ctx, propertyId, Number(sinceDays ?? 30));
  }

  @Get()
  list(
    @Ctx() ctx: RequestContext,
    @Query('propertyId') propertyId?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return this.bookings.list(ctx, { propertyId, status, limit: limit ? Number(limit) : undefined });
  }

  @Post(':id/cancel')
  cancel(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.bookings.cancel(ctx, id, body?.reason ?? 'cancelled by buyer');
  }

  @Post('reconcile-unknown')
  reconcile(@Ctx() ctx: RequestContext, @Body() body: { olderThanSeconds?: number }) {
    return this.bookings.reconcileUnknown(ctx, body?.olderThanSeconds ?? 120);
  }
}
