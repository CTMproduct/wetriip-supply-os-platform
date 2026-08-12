import 'reflect-metadata';
import { bootstrapService } from '@wetriip/service-kit';
import { AgentModule } from './agent.module';

void bootstrapService({ service: 'agent', module: AgentModule });
