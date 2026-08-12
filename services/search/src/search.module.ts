import { Module } from '@nestjs/common';
import { OutboxRelay, PlatformModule, healthControllerFor } from '@wetriip/service-kit';
import { DemandService } from './demand.service';
import { DiagnosticsService } from './diagnostics.service';
import { OfferService } from './offer.service';
import { RevenueService } from './revenue.service';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

@Module({
  imports: [PlatformModule.forService('search')],
  controllers: [SearchController, healthControllerFor('search')],
  providers: [
    SearchService,
    OfferService,
    DiagnosticsService,
    RevenueService,
    DemandService,
    OutboxRelay,
  ],
  exports: [SearchService, OfferService, DiagnosticsService, RevenueService, DemandService],
})
export class SearchModule {}
