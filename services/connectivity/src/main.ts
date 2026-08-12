import 'reflect-metadata';
import { bootstrapService } from '@wetriip/service-kit';
import { ConnectivityModule } from './connectivity.module';

void bootstrapService({ service: 'connectivity', module: ConnectivityModule });
