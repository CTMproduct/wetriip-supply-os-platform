import { Module } from '@nestjs/common';
import { OutboxRelay, PlatformModule, healthControllerFor } from '@wetriip/service-kit';
import { CatalogService } from './catalog.service';
import { CommercialService } from './commercial.service';
import { ContentService } from './content.service';
import { CoreController } from './core.controller';
import { DistributionService } from './distribution.service';
import { PartnerService } from './partner.service';
import { UserService } from './user.service';

@Module({
  imports: [PlatformModule.forService('core-commerce')],
  controllers: [CoreController, healthControllerFor('core-commerce')],
  providers: [
    CatalogService,
    CommercialService,
    ContentService,
    DistributionService,
    PartnerService,
    UserService,
    OutboxRelay,
  ],
  exports: [
    CatalogService,
    CommercialService,
    ContentService,
    DistributionService,
    PartnerService,
    UserService,
  ],
})
export class CoreCommerceModule {}
