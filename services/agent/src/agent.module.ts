import { Module } from '@nestjs/common';
import { OutboxRelay, PlatformModule, healthControllerFor } from '@wetriip/service-kit';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { ChatController } from './chat.controller';
import { ChatToolsService } from './chat-tools.service';
import { ConversationService } from './conversation.service';
import { ExecutorService } from './executor.service';
import { IntentService } from './intent.service';
import { ToolsService } from './tools.service';

@Module({
  imports: [PlatformModule.forService('agent')],
  controllers: [AgentController, ChatController, healthControllerFor('agent')],
  providers: [
    AgentService,
    IntentService,
    ToolsService,
    ExecutorService,
    ChatToolsService,
    ConversationService,
    OutboxRelay,
  ],
  exports: [AgentService, ConversationService],
})
export class AgentModule {}
