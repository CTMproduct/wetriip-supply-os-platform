import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Ctx, RequestContext } from '@wetriip/service-kit';
import { ReconciliationService } from './reconciliation.service';

@Controller('internal/reconciliation')
export class ReconciliationController {
  constructor(private readonly recon: ReconciliationService) {}

  @Post('run')
  run(
    @Ctx() ctx: RequestContext,
    @Body() body: { propertyId: string; from?: string; to?: string; connectionId?: string },
  ) {
    return this.recon.run(ctx, body);
  }

  @Get('runs')
  list(@Ctx() ctx: RequestContext, @Query('limit') limit?: string) {
    return this.recon.list(ctx, limit ? Number(limit) : 25);
  }
}
