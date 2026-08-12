import { Module } from '@nestjs/common';
import { OutboxRelay, PlatformModule, healthControllerFor } from '@wetriip/service-kit';
import { BlockService } from './block.service';
import { EventSpaceService } from './eventspace.service';
import { ExpiryScheduler } from './expiry.scheduler';
import { GroupsController } from './groups.controller';
import { InventoryService } from './inventory.service';
import { NotificationService } from './notification.service';
import { RequestService } from './request.service';

@Module({
  imports: [PlatformModule.forService('groups')],
  controllers: [GroupsController, healthControllerFor('groups')],
  providers: [
    BlockService,
    RequestService,
    InventoryService,
    EventSpaceService,
    NotificationService,
    ExpiryScheduler,
    OutboxRelay,
  ],
  exports: [BlockService, RequestService, EventSpaceService, NotificationService, InventoryService],
})
export class GroupsModule {}
