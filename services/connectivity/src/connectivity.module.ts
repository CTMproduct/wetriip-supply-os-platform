import { Module } from '@nestjs/common';
import { OutboxRelay, PlatformModule, healthControllerFor } from '@wetriip/service-kit';
import { ConnectionService } from './connection.service';
import { ConnectivityController, WebhookController } from './connectivity.controller';
import { MappingService } from './mapping.service';
import { PullScheduler } from './pull.scheduler';
import { registryProviders } from './registry.provider';

@Module({
  imports: [PlatformModule.forService('connectivity')],
  controllers: [ConnectivityController, WebhookController, healthControllerFor('connectivity')],
  providers: [...registryProviders, ConnectionService, MappingService, PullScheduler, OutboxRelay],
  exports: [ConnectionService, MappingService, PullScheduler],
})
export class ConnectivityModule {}
