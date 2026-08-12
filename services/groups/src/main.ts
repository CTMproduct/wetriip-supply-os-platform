import 'reflect-metadata';
import { bootstrapService } from '@wetriip/service-kit';
import { GroupsModule } from './groups.module';

void bootstrapService({ service: 'groups', module: GroupsModule });
