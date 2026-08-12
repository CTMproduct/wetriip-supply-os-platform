import 'reflect-metadata';
import { bootstrapService } from '@wetriip/service-kit';
import { CoreCommerceModule } from './core-commerce.module';

void bootstrapService({ service: 'core-commerce', module: CoreCommerceModule });
