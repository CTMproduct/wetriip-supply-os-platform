import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ChatStreamEvent } from '@wetriip/contracts';
import { Ctx, RequestContext } from '@wetriip/service-kit';
import { ConversationService } from './conversation.service';

/**
 * Conversation endpoints.
 *
 * The turn is streamed as server-sent events so the console can show tool steps
 * and text as they happen rather than a spinner. The alternative — buffering
 * the whole turn — makes a multi-tool answer feel broken for ten seconds, and
 * hides the fact that the assistant is reading real data.
 */
@Controller('internal/agent/chat')
export class ChatController {
  constructor(private readonly conversation: ConversationService) {}

  @Post('stream')
  async stream(@Ctx() ctx: RequestContext, @Body() body: unknown, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Defeats proxy buffering, which otherwise holds the whole stream back.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (event: ChatStreamEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      await this.conversation.chat(ctx, body, send);
    } catch (err) {
      send({
        type: 'error',
        code: 'INTERNAL',
        message: err instanceof Error ? err.message : 'Conversation failed',
      });
    } finally {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }

  @Get('sessions')
  sessions(@Ctx() ctx: RequestContext, @Query('limit') limit?: string) {
    return this.conversation.listSessions(ctx, limit ? Number(limit) : 30);
  }

  @Get('sessions/:id')
  thread(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.conversation.getThread(ctx, id);
  }
}
