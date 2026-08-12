import { Module } from '@nestjs/common';
import { OutboxRelay, PlatformModule, healthControllerFor } from '@wetriip/service-kit';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationService } from './reconciliation.service';

@Module({
  imports: [PlatformModule.forService('reconciliation')],
  controllers: [ReconciliationController, healthControllerFor('reconciliation')],
  providers: [ReconciliationService, OutboxRelay],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
