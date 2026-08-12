import 'reflect-metadata';
import { bootstrapService } from '@wetriip/service-kit';
import { BookingModule } from './booking.module';

void bootstrapService({ service: 'booking', module: BookingModule });
