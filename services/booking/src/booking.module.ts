import { Module } from '@nestjs/common';
import { OutboxRelay, PlatformModule, healthControllerFor } from '@wetriip/service-kit';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';

@Module({
  imports: [PlatformModule.forService('booking')],
  controllers: [BookingController, healthControllerFor('booking')],
  providers: [BookingService, OutboxRelay],
  exports: [BookingService],
})
export class BookingModule {}
