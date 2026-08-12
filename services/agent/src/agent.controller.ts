import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Ctx, RequestContext } from '@wetriip/service-kit';
import { AgentService } from './agent.service';
import { IntentService } from './intent.service';

@Controller('internal/agent')
export class AgentController {
  constructor(
    private readonly agent: AgentService,
    private readonly intent: IntentService,
  ) {}

  /** One entry point for voice, chat and API. The channel changes the
   *  transcription, never the safety path. */
  @Post('ask')
  ask(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.agent.ask(ctx, body);
  }

  @Post('actions/:id/confirm')
  confirm(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.agent.confirm(ctx, id);
  }

  @Post('actions/:id/reject')
  reject(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.agent.reject(ctx, id, body?.reason ?? 'rejected by user');
  }

  @Post('actions/:id/rollback')
  rollback(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.agent.rollback(ctx, id, body?.reason ?? 'rollback requested');
  }

  @Get('actions')
  list(@Ctx() ctx: RequestContext, @Query('limit') limit?: string) {
    return this.agent.listActions(ctx, limit ? Number(limit) : 50);
  }

  @Get('actions/:id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.agent.getAction(ctx, id);
  }

  /** Transparency for the console: whether a model is in the loop at all. */
  @Get('capabilities')
  capabilities() {
    return {
      llmConfigured: this.intent.llmAvailable,
      model: this.intent.llmAvailable ? (process.env.AGENT_MODEL ?? 'claude-sonnet-5') : null,
      deterministicGrammar: true,
      globalMaxAutonomy: Number(process.env.AGENT_MAX_AUTONOMY ?? 2),
      limits: {
        maxDiscountPct: Number(process.env.POLICY_MAX_DISCOUNT_PCT ?? 25),
        maxRateDeltaPct: Number(process.env.POLICY_MAX_RATE_DELTA_PCT ?? 20),
        maxBlastRadiusCells: Number(process.env.POLICY_MAX_BLAST_RADIUS_CELLS ?? 5000),
      },
      note: 'The model only produces a StructuredCommand. Validation, simulation, authorisation and execution are deterministic and identical whether or not a model is configured.',
    };
  }
}
