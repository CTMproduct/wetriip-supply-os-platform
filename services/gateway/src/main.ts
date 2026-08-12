import 'reflect-metadata';
import { bootstrapService } from '@wetriip/service-kit';
import { GatewayModule } from './gateway.module';

void bootstrapService({ service: 'gateway', module: GatewayModule, cors: true });
