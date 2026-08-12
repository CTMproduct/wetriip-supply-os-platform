import { Module } from '@nestjs/common';
import { OutboxRelay, PlatformModule, healthControllerFor } from '@wetriip/service-kit';
import { AriController } from './ari.controller';
import { EffectiveAriService } from './effective.service';
import { AriHealthService } from './health.service';
import { IngestionService } from './ingestion.service';

@Module({
  imports: [PlatformModule.forService('ari-ingestion')],
  controllers: [AriController, healthControllerFor('ari-ingestion')],
  providers: [IngestionService, EffectiveAriService, AriHealthService, OutboxRelay],
  exports: [IngestionService, EffectiveAriService, AriHealthService],
})
export class AriIngestionModule {}
