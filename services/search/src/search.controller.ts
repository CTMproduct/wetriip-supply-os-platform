import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Ctx, RequestContext } from '@wetriip/service-kit';
import { DemandService } from './demand.service';
import { DiagnosticsService } from './diagnostics.service';
import { OfferService } from './offer.service';
import { RevenueService } from './revenue.service';
import { SearchService } from './search.service';

@Controller('internal/search')
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly offers: OfferService,
    private readonly diagnostics: DiagnosticsService,
    private readonly revenue: RevenueService,
    private readonly demand: DemandService,
  ) {}

  @Post()
  run(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.search.search(ctx, body);
  }

  @Get('offers/:id')
  getOffer(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.offers.get(ctx, id);
  }

  @Post('offers/:id/revalidate')
  revalidate(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.offers.revalidate(ctx, id);
  }

  @Get('revenue-advisory')
  revenueAdvisory(
    @Ctx() ctx: RequestContext,
    @Query('propertyId') propertyId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.revenue.advisory(ctx, { propertyId, from, to });
  }

  @Get('partner-production')
  partnerProduction(
    @Ctx() ctx: RequestContext,
    @Query('propertyId') propertyId: string,
    @Query('sinceDays') sinceDays?: string,
  ) {
    return this.revenue.partnerProduction(ctx, {
      propertyId,
      sinceDays: sinceDays ? Number(sinceDays) : undefined,
    });
  }

  @Get('property-demand')
  propertyDemand(
    @Ctx() ctx: RequestContext,
    @Query('propertyId') propertyId: string,
    @Query('days') days?: string,
  ) {
    return this.demand.propertyDemand(ctx, { propertyId, days: days ? Number(days) : undefined });
  }

  @Get('travel-flow')
  travelFlow(
    @Ctx() ctx: RequestContext,
    @Query('direction') direction: 'OUTBOUND' | 'INBOUND',
    @Query('anchor') anchor: string,
    @Query('days') days?: string,
  ) {
    return this.demand.travelFlow(ctx, {
      direction: direction === 'INBOUND' ? 'INBOUND' : 'OUTBOUND',
      anchor,
      days: days ? Number(days) : undefined,
    });
  }

  @Get('diagnose')
  diagnose(
    @Ctx() ctx: RequestContext,
    @Query('propertyId') propertyId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('market') market?: string,
  ) {
    return this.diagnostics.run(ctx, { propertyId, from, to, market });
  }
}
