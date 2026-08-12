import 'reflect-metadata';
import { bootstrapService } from '@wetriip/service-kit';
import { ReconciliationModule } from './reconciliation.module';

void bootstrapService({ service: 'reconciliation', module: ReconciliationModule });
