import 'reflect-metadata';
import { bootstrapService } from '@wetriip/service-kit';
import { AriIngestionModule } from './ari-ingestion.module';

void bootstrapService({ service: 'ari-ingestion', module: AriIngestionModule });
