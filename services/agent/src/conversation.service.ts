import { Inject, Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import type { PrismaClient } from '@prisma/client';
import {
  AgentActionView,
  ChatRequest,
  ChatRequestSchema,
  ChatStreamEvent,
  ConversationMessage,
  RevenueAdvisory,
  StructuredCommandSchema,
  ToolStep,
  toStayDate,
} from '@wetriip/contracts';
import { parseIntent } from '@wetriip/domain';
import { Logger, M, metrics } from '@wetriip/observability';
import { LOGGER, PRISMA, RequestContext } from '@wetriip/service-kit';
import { AgentService } from './agent.service';
import { CHAT_TOOLS, ChatToolsService } from './chat-tools.service';
import { CONVERSATION_SYSTEM_PROMPT } from './conversation.prompt';

/**
 * The AI Command Center.
 *
 * A real assistant: it holds a thread, reads freely to ground what it says, and
 * answers in prose. What it cannot do is unchanged, and the tool split is what
 * enforces it:
 *
 *   READ tools run immediately — none of them change anything.
 *   `propose_change` cannot execute. It validates a StructuredCommand,
 *   simulates it against live inventory, evaluates policy, and returns a
 *   proposal. A human confirms it on exactly the same path a typed command
 *   takes.
 *
 * So the model can be as fluent as it likes about revenue strategy and still
 * cannot move a single rate on its own.
 *
 * Without an API key the whole surface still works through the deterministic
 * grammar plus the advisory engine's own prose. Less fluent, same capabilities,
 * same guarantees — and it is the path the tests run against.
 */
@Injectable()
export class ConversationService {
  private readonly anthropic: Anthropic | null;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly log: Logger,
    private readonly agent: AgentService,
    private readonly tools: ChatToolsService,
  ) {
    const key = process.env.ANTHROPIC_API_KEY;
    this.anthropic = key ? new Anthropic({ apiKey: key }) : null;
  }

  get llmAvailable(): boolean {
    return this.anthropic != null;
  }

  async listSessions(ctx: RequestContext, limit = 30) {
    const rows = await this.prisma.agentSession.findMany({
      where: { tenantId: ctx.tenantId, userId: ctx.userId, title: { not: null } },
      orderBy: { updatedAt: 'desc' },
      take: Math.min(limit, 100),
      select: { id: true, title: true, channel: true, createdAt: true, updatedAt: true },
    });
    return rows;
  }

  async getThread(ctx: RequestContext, sessionId: string): Promise<ConversationMessage[]> {
    const rows = await this.prisma.agentMessage.findMany({
      where: { sessionId, tenantId: ctx.tenantId },
      orderBy: { createdAt: 'asc' },
    });

    const proposalIds = rows.flatMap((r) => r.proposalIds);
    const actions = proposalIds.length
      ? await this.prisma.agentAction.findMany({ where: { id: { in: proposalIds } } })
      : [];

    return rows.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      role: r.role as 'user' | 'assistant',
      content: r.content,
      steps: (r.steps ?? []) as unknown as ToolStep[],
      proposals: actions
        .filter((a) => r.proposalIds.includes(a.id))
        .map((a) => this.actionView(a)),
      createdAt: r.createdAt.toISOString(),
      modelId: r.modelId,
      deterministic: r.deterministic,
    }));
  }

  /**
   * One conversational turn. `emit` receives server-sent events as they happen,
   * so the console can show tool steps and streaming text rather than a spinner.
   */
  async chat(
    ctx: RequestContext,
    input: unknown,
    emit: (event: ChatStreamEvent) => void,
  ): Promise<void> {
    const req: ChatRequest = ChatRequestSchema.parse(input);

    const session = await this.agent.ensureSession(
      ctx,
      req.sessionId,
      req.channel,
      req.context,
      req.message,
    );

    await this.prisma.agentMessage.create({
      data: {
        sessionId: session.id,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        role: 'user',
        content: req.message,
        proposalIds: [],
        correlationId: ctx.correlationId,
        deterministic: true,
      },
    });
    await this.prisma.agentSession.update({
      where: { id: session.id },
      data: { updatedAt: new Date(), title: session.title ?? req.message.slice(0, 120) },
    });

    const assistantId = `msg_${Math.random().toString(36).slice(2, 12)}`;
    emit({ type: 'session', sessionId: session.id, messageId: assistantId });

    const steps: ToolStep[] = [];
    const proposals: AgentActionView[] = [];
    let text = '';

    try {
      if (this.anthropic) {
        text = await this.runModelTurn(ctx, session.id, req, emit, steps, proposals);
      } else {
        text = await this.runDeterministicTurn(ctx, session.id, req, emit, steps, proposals);
      }
    } catch (err) {
      this.log.error('conversation turn failed', {
        correlationId: ctx.correlationId,
        error: String(err),
      });
      const message =
        err instanceof Error ? err.message : 'The assistant could not complete this turn.';
      emit({
        type: 'error',
        code: 'INTERNAL',
        message,
        remediation: 'The correlation id identifies this turn in the logs.',
      });
      text = text || `I could not complete that: ${message}`;
    }

    const saved = await this.prisma.agentMessage.create({
      data: {
        id: assistantId,
        sessionId: session.id,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        role: 'assistant',
        content: text,
        steps: steps as any,
        proposalIds: proposals.map((p) => p.id),
        modelId: this.anthropic ? (process.env.AGENT_MODEL ?? 'claude-sonnet-5') : null,
        deterministic: !this.anthropic,
        correlationId: ctx.correlationId,
      },
    });

    emit({
      type: 'done',
      message: {
        id: saved.id,
        sessionId: session.id,
        role: 'assistant',
        content: text,
        steps,
        proposals,
        createdAt: saved.createdAt.toISOString(),
        modelId: saved.modelId,
        deterministic: saved.deterministic,
      },
    });
  }

  // ── Model path ───────────────────────────────────────────

  private async runModelTurn(
    ctx: RequestContext,
    sessionId: string,
    req: ChatRequest,
    emit: (e: ChatStreamEvent) => void,
    steps: ToolStep[],
    proposals: AgentActionView[],
  ): Promise<string> {
    const modelId = process.env.AGENT_MODEL ?? 'claude-sonnet-5';
    const history = await this.recentHistory(ctx, sessionId);

    const messages: Anthropic.MessageParam[] = [
      ...history,
      {
        role: 'user',
        content: `${req.message}\n\n<context>${JSON.stringify({
          today: toStayDate(new Date()),
          screen: req.context ?? {},
          user: { role: ctx.role, autonomyLevel: ctx.maxAutonomy },
        })}</context>`,
      },
    ];

    let finalText = '';
    const started = Date.now();

    // Bounded: a runaway tool loop is a cost incident, and eight steps is more
    // than any question here legitimately needs.
    for (let round = 0; round < 8; round++) {
      const stream = this.anthropic!.messages.stream({
        model: modelId,
        max_tokens: 4000,
        system: CONVERSATION_SYSTEM_PROMPT,
        tools: CHAT_TOOLS as any,
        messages,
      });

      stream.on('text', (delta) => {
        finalText += delta;
        emit({ type: 'text', delta });
      });

      const message = await stream.finalMessage();
      const toolUses = message.content.filter(
        (c): c is Anthropic.ToolUseBlock => c.type === 'tool_use',
      );

      if (message.stop_reason !== 'tool_use' || toolUses.length === 0) {
        metrics.observe(M.agentLlmLatency, Date.now() - started, { model: modelId });
        return finalText.trim();
      }

      messages.push({ role: 'assistant', content: message.content });

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const step = await this.executeTool(ctx, sessionId, req, use, emit, steps, proposals);
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: JSON.stringify(step.payload).slice(0, 60_000),
          is_error: step.isError,
        });
      }
      messages.push({ role: 'user', content: results });
    }

    return (
      finalText.trim() ||
      'I gathered the data but ran out of steps before answering. Ask me again and I will be more direct.'
    );
  }

  private async executeTool(
    ctx: RequestContext,
    sessionId: string,
    req: ChatRequest,
    use: Anthropic.ToolUseBlock,
    emit: (e: ChatStreamEvent) => void,
    steps: ToolStep[],
    proposals: AgentActionView[],
  ): Promise<{ payload: unknown; isError: boolean }> {
    const definition = CHAT_TOOLS.find((t) => t.name === use.name);
    const step: ToolStep = {
      id: use.id,
      name: use.name,
      label: definition?.label ?? use.name,
      input: (use.input ?? {}) as Record<string, unknown>,
      status: 'RUNNING',
    };
    steps.push(step);
    emit({ type: 'step', step });

    const started = Date.now();
    try {
      if (use.name === 'propose_change') {
        const outcome = await this.proposeFromModel(ctx, sessionId, req, use.input as any);
        Object.assign(step, {
          status: outcome.isError ? 'ERROR' : 'OK',
          summary: outcome.summary,
          error: outcome.isError ? outcome.summary : undefined,
          durationMs: Date.now() - started,
        });
        emit({ type: 'step', step });
        if (outcome.action) {
          proposals.push(outcome.action);
          emit({ type: 'proposal', action: outcome.action });
        }
        return { payload: outcome.payload, isError: outcome.isError };
      }

      const outcome = await this.tools.run(ctx, use.name, use.input);
      Object.assign(step, {
        status: 'OK',
        summary: outcome.summary,
        card: outcome.card ?? null,
        durationMs: Date.now() - started,
      });
      emit({ type: 'step', step });
      return { payload: outcome.result, isError: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Object.assign(step, {
        status: 'ERROR',
        error: message,
        durationMs: Date.now() - started,
      });
      emit({ type: 'step', step });
      // The error goes back to the model as a tool result so it can adapt,
      // rather than failing the whole turn.
      return { payload: { error: message }, isError: true };
    }
  }

  /**
   * The write airlock.
   *
   * The model hands over a candidate command. Zod decides whether it is a
   * command at all; the policy and simulation engines decide whether it may be
   * offered. Nothing here executes. A validation failure returns the exact
   * issues so the model can correct itself once — which is far more reliable
   * than a rigid JSON schema it cannot see the errors from.
   */
  private async proposeFromModel(
    ctx: RequestContext,
    sessionId: string,
    req: ChatRequest,
    input: { command?: unknown; rationale?: string },
  ): Promise<{ payload: unknown; isError: boolean; summary: string; action?: AgentActionView }> {
    const parsed = StructuredCommandSchema.safeParse(input?.command);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
      return {
        isError: true,
        summary: `Command rejected by validation: ${issues.slice(0, 4).join('; ')}`,
        payload: {
          accepted: false,
          reason: 'SCHEMA_VALIDATION_FAILED',
          issues,
          hint: 'Fix these fields and call propose_change once more. Do not invent ids or dates the user did not give you.',
        },
      };
    }

    const command = parsed.data;
    if (command.kind.startsWith('get_') || command.kind === 'list_promotions' || command.kind === 'explain_no_sales') {
      return {
        isError: true,
        summary: 'Read commands must use the read tools, not propose_change.',
        payload: { accepted: false, reason: 'READ_COMMAND', hint: 'Use the corresponding read tool.' },
      };
    }

    const { action, policy, simulation } = await this.agent.propose(
      ctx,
      sessionId,
      command,
      input?.rationale ? `${req.message} — ${input.rationale}` : req.message,
      { deterministic: false, modelId: process.env.AGENT_MODEL ?? 'claude-sonnet-5' },
    );

    if (!policy.allowed) {
      return {
        isError: false,
        summary: `Refused by policy: ${policy.denialReason}`,
        action,
        payload: {
          accepted: false,
          reason: 'POLICY_DENIED',
          denialReason: policy.denialReason,
          failedChecks: policy.checks.filter((c) => !c.passed),
          hint: 'Tell the user plainly why this is not permitted and what would be. Do not retry the same command.',
        },
      };
    }

    return {
      isError: false,
      summary: simulation.confirmationPrompt,
      action,
      payload: {
        accepted: true,
        status: 'AWAITING_CONFIRMATION',
        actionId: action.id,
        riskLevel: policy.riskLevel,
        requiresStepUp: policy.requiresStepUp,
        blastRadius: simulation.blastRadius,
        projections: simulation.projections,
        warnings: simulation.warnings,
        confirmationPrompt: simulation.confirmationPrompt,
        hint: 'The proposal is now shown to the user with a Confirm button. Describe what it will do and its warnings. Do NOT claim it has been applied.',
      },
    };
  }

  private async recentHistory(
    ctx: RequestContext,
    sessionId: string,
  ): Promise<Anthropic.MessageParam[]> {
    const rows = await this.prisma.agentMessage.findMany({
      where: { sessionId, tenantId: ctx.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 12,
    });
    return rows
      .reverse()
      .filter((r) => r.content?.trim())
      .map((r) => ({
        role: r.role === 'user' ? ('user' as const) : ('assistant' as const),
        content: r.content,
      }));
  }

  // ── Deterministic path (no API key) ──────────────────────

  /**
   * Same capabilities, no model. The grammar handles commands; the advisory
   * engine's own prose handles the revenue questions. This is the path the
   * automated tests exercise, which is why it has to be genuinely useful rather
   * than a stub.
   */
  private async runDeterministicTurn(
    ctx: RequestContext,
    sessionId: string,
    req: ChatRequest,
    emit: (e: ChatStreamEvent) => void,
    steps: ToolStep[],
    proposals: AgentActionView[],
  ): Promise<string> {
    const parsed = parseIntent(req.message, {
      now: new Date(),
      propertyId: req.context?.propertyId ?? null,
      roomTypeCode: req.context?.roomTypeCode ?? null,
      ratePlanCode: req.context?.ratePlanCode ?? null,
      selectedDates: req.context?.selectedDates ?? null,
      market: req.context?.market ?? null,
    });

    // A recognised write command becomes a proposal, exactly as with the model.
    if (parsed.matched && parsed.command && !isReadKind(parsed.command.kind)) {
      const { action, policy, simulation } = await this.agent.propose(
        ctx,
        sessionId,
        parsed.command,
        req.message,
        { deterministic: true, modelId: null },
      );
      if (!policy.allowed) {
        return this.stream(emit, `I cannot do that. ${policy.denialReason}`);
      }
      proposals.push(action);
      emit({ type: 'proposal', action });
      return this.stream(
        emit,
        `${simulation.confirmationPrompt}${simulation.warnings.length ? ` ${simulation.warnings.join(' ')}` : ''} Nothing has been changed yet — confirm below and I will apply it.`,
      );
    }

    const propertyId = req.context?.propertyId ?? null;
    const wantsRevenue =
      /revpar|rev par|adr|ocupaci|occupan|tarifa|rate|precio|price|mejorar|improve|ingres|revenue|rendimiento|performance|distribu|agenci|partner|mayorista|wholesal/i.test(
        req.message,
      );

    if (wantsRevenue && propertyId) {
      const step: ToolStep = {
        id: `step_${Date.now()}`,
        name: 'get_revenue_advisory',
        label: 'Reading revenue performance',
        input: { propertyId },
        status: 'RUNNING',
      };
      steps.push(step);
      emit({ type: 'step', step });

      const outcome = await this.tools.run(ctx, 'get_revenue_advisory', { propertyId });
      Object.assign(step, { status: 'OK', summary: outcome.summary, card: outcome.card ?? null });
      emit({ type: 'step', step });

      const advisory = (outcome.card?.data ?? null) as RevenueAdvisory | null;
      return this.stream(emit, advisory ? narrateAdvisory(advisory) : outcome.summary);
    }

    if (parsed.matched && parsed.command) {
      const result = await this.agent.ask(ctx, {
        utterance: req.message,
        channel: req.channel,
        sessionId,
        context: req.context ?? undefined,
      });
      return this.stream(emit, result.speech);
    }

    return this.stream(
      emit,
      `${parsed.reason ?? 'I could not turn that into something I can act on.'}\n\n` +
        `No language model is configured, so I am running on the deterministic parser. I can still: explain why a property is not selling, read availability and ARI health, check connectivity, list and change promotions, move rates, adjust availability and set stay restrictions — and analyse RevPAR, ADR, occupancy and partner production if you open a property first.\n\n` +
        `Set ANTHROPIC_API_KEY to have me answer open-ended revenue questions in full.`,
    );
  }

  /** Chunked so the console renders the same way on both paths. */
  private stream(emit: (e: ChatStreamEvent) => void, text: string): string {
    for (const chunk of text.match(/[\s\S]{1,90}/g) ?? []) {
      emit({ type: 'text', delta: chunk });
    }
    return text;
  }

  private actionView(row: any): AgentActionView {
    return {
      id: row.id,
      sessionId: row.sessionId,
      agent: row.agent,
      intent: row.intent,
      utterance: row.utterance,
      command: row.command,
      status: row.status,
      autonomyLevel: row.autonomyLevel,
      riskLevel: row.riskLevel,
      requiresStepUp: row.requiresStepUp,
      deterministicIntent: row.deterministicIntent,
      modelId: row.modelId,
      policyDecision: row.policyDecision,
      simulation: row.simulation,
      result: row.result,
      error: row.error,
      correlationId: row.correlationId,
      createdAt: row.createdAt.toISOString(),
      executedAt: row.executedAt?.toISOString() ?? null,
      rollbackOfId: row.rollbackOfId,
      rolledBackById: row.rolledBackById,
    };
  }
}

function isReadKind(kind: string): boolean {
  return (
    kind.startsWith('get_') || kind === 'list_promotions' || kind === 'explain_no_sales'
  );
}

/**
 * Deterministic narration of an advisory.
 *
 * Every sentence here is assembled from numbers the engine computed. It reads
 * like a revenue manager because the findings were written like one — not
 * because a model rephrased them.
 */
function narrateAdvisory(a: RevenueAdvisory): string {
  const parts: string[] = [a.headline, ''];

  const critical = a.findings.filter((f) => f.severity === 'CRITICAL');
  const opportunities = a.findings.filter((f) => f.severity === 'OPPORTUNITY');
  const warnings = a.findings.filter((f) => f.severity === 'WARNING');

  if (critical.length) {
    parts.push('**Blocking first**');
    for (const f of critical) parts.push(`- **${f.title}.** ${f.detail}`);
    parts.push('');
  }

  if (opportunities.length) {
    parts.push('**Where the upside is**');
    for (const f of opportunities) parts.push(`- **${f.title}.** ${f.detail}`);
    parts.push('');
  }

  if (warnings.length) {
    parts.push('**Worth fixing**');
    for (const f of warnings) parts.push(`- **${f.title}.** ${f.detail}`);
    parts.push('');
  }

  if (a.partners.length >= 2) {
    parts.push('**Partner production**');
    parts.push('| Partner | Bookings | Room nights | Net ADR | Commission |');
    parts.push('|---|---:|---:|---:|---:|');
    for (const p of a.partners.slice(0, 6)) {
      const netAdr = p.netRevenue != null && p.roomNights > 0 ? Math.round(p.netRevenue / p.roomNights) : null;
      parts.push(
        `| ${p.name} | ${p.bookings} | ${p.roomNights} | ${netAdr ?? '—'} | ${p.commissionPct ?? 0}% |`,
      );
    }
    parts.push('');
  }

  parts.push(`_${a.competitive.basis}_`);

  if (a.findings.some((f) => f.suggestedCommand)) {
    parts.push('');
    parts.push('I can prepare the changes marked below — you would confirm before anything is applied.');
  }

  return parts.join('\n');
}
