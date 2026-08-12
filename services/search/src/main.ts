import 'reflect-metadata';
import { bootstrapService } from '@wetriip/service-kit';
import { SearchModule } from './search.module';

void bootstrapService({ service: 'search', module: SearchModule });
