import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { EventBus } from '@wetriip/bus';
import {
  AgentAskInput,
  AgentAskResponse,
  AgentAskSchema,
  AgentActionView,
  AutonomyLevel,
  DomainError,
  PolicyDecision,
  SimulationResult,
  StructuredCommand,
  isReadCommand,
} from '@wetriip/contracts';
import { PolicyLimits, evaluatePolicy, simulate } from '@wetriip/domain';
import { Logger, M, metrics } from '@wetriip/observability';
import { AuditLog } from '@wetriip/persistence';
import { AUDIT_LOG, EVENT_BUS, LOGGER, PRISMA, RequestContext, clients } from '@wetriip/service-kit';
import { ExecutorService } from './executor.service';
import { IntentService } from './intent.service';
import { ToolsService } from './tools.service';

/**
 * Supply Orchestrator.
 *
 * The full path, every time, for every channel — voice, chat, REST, or a
 * button in the console:
 *
 *   utterance -> intent -> StructuredCommand -> simulation -> policy
 *             -> confirmation -> execution -> verification -> audit
 *
 * Read commands short-circuit after the tool call because they change nothing.
 * Write commands ALWAYS stop at confirmation unless an explicit Level-3 policy
 * says otherwise, and HIGH risk stops for a human regardless of autonomy.
 *
 * Note the ordering of simulation before policy: several limits (blast radius,
 * floor rate, resulting ADR) are only knowable once you have computed the diff.
 * A policy engine that runs first can only check the things the user typed,
 * which is exactly the set of things a mistaken command gets wrong.
 */
@Injectable()
export class AgentService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(LOGGER) private readonly log: Logger,
    private readonly intent: IntentService,
    private readonly tools: ToolsService,
    private readonly executor: ExecutorService,
  ) {}

  private get limits(): Partial<PolicyLimits> {
    return {
      maxDiscountPct: Number(process.env.POLICY_MAX_DISCOUNT_PCT ?? 25),
      maxRateDeltaPct: Number(process.env.POLICY_MAX_RATE_DELTA_PCT ?? 20),
      maxBlastRadiusCells: Number(process.env.POLICY_MAX_BLAST_RADIUS_CELLS ?? 5000),
    };
  }

  private get globalAutonomy(): AutonomyLevel {
    const n = Number(process.env.AGENT_MAX_AUTONOMY ?? 2);
    return (n === 1 || n === 2 || n === 3 ? n : 2) as AutonomyLevel;
  }

  async ask(ctx: RequestContext, input: unknown): Promise<AgentAskResponse> {
    const req: AgentAskInput = AgentAskSchema.parse(input);

    const session = req.sessionId
      ? await this.prisma.agentSession.findUnique({ where: { id: req.sessionId } })
      : null;
    const activeSession =
      session ??
      (await this.prisma.agentSession.create({
        data: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          channel: req.channel,
          context: (req.context ?? {}) as any,
        },
      }));

    // ── 1. Intent ──────────────────────────────────────────
    const parsed = await this.intent.extract(ctx, req.utterance, {
      now: new Date(),
      propertyId: req.context?.propertyId ?? null,
      roomTypeCode: req.context?.roomTypeCode ?? null,
      ratePlanCode: req.context?.ratePlanCode ?? null,
      selectedDates: req.context?.selectedDates ?? null,
      market: req.context?.market ?? null,
    });

    if (!parsed.matched || !parsed.command) {
      // We still record the attempt: unparsed utterances are the training set
      // for the grammar and the measure of whether the model is earning its
      // place.
      const action = await this.persistAction(ctx, activeSession.id, {
        agent: 'SupplyOrchestrator',
        utterance: req.utterance,
        intent: parsed.intent,
        command: {} as any,
        status: 'REJECTED',
        deterministic: parsed.deterministic,
        modelId: parsed.modelId,
        rejectReason: parsed.reason ?? 'not understood',
        autonomyLevel: 1,
        riskLevel: 'LOW',
      });
      return {
        action,
        speech: parsed.reason ?? 'I could not turn that into an action I am allowed to take.',
        requiresConfirmation: false,
      };
    }

    const command = parsed.command;
    const agent = agentFor(command);

    // ── 2. Read commands: answer and stop ──────────────────
    if (isReadCommand(command.kind)) {
      const policy = evaluatePolicy({
        command,
        // The agent inherits the caller's resolved permissions and property
        // scope. It never carries authority of its own — that is the reason
        // an e-commerce analyst can ask for a rate change and be refused.
        actor: {
          userId: ctx.userId,
          role: ctx.role,
          maxAutonomy: ctx.maxAutonomy,
          organizationId: ctx.organizationId,
          tenantId: ctx.tenantId,
          permissions: ctx.permissions,
          propertyIds: ctx.propertyIds,
        },
        simulation: null,
        limits: this.limits,
        globalMaxAutonomy: this.globalAutonomy,
      });
      if (!policy.allowed) return this.denied(ctx, activeSession.id, req, command, policy, parsed);

      const result = await this.tools.runRead(ctx, command);
      const action = await this.persistAction(ctx, activeSession.id, {
        agent,
        utterance: req.utterance,
        intent: command.kind,
        command,
        status: 'EXECUTED',
        deterministic: parsed.deterministic,
        modelId: parsed.modelId,
        policyDecision: policy,
        autonomyLevel: policy.autonomyLevel,
        riskLevel: 'LOW',
        result: { summary: result.speech },
      });
      return { action, speech: result.speech, data: result.data, requiresConfirmation: false };
    }

    // ── 3. Write commands: simulate FIRST ──────────────────
    const cells = await this.tools.cellsForCommand(ctx, command);
    const simulation = simulate({ command, cells });

    // ── 4. Policy, with the diff in hand ───────────────────
    const policy = evaluatePolicy({
      command,
      // The agent inherits the caller's resolved permissions and property
      // scope. It never carries authority of its own — that is the reason
      // an e-commerce analyst can ask for a rate change and be refused.
      actor: {
        userId: ctx.userId,
        role: ctx.role,
        maxAutonomy: ctx.maxAutonomy,
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        permissions: ctx.permissions,
        propertyIds: ctx.propertyIds,
      },
      simulation,
      limits: this.limits,
      globalMaxAutonomy: this.globalAutonomy,
    });

    if (!policy.allowed) {
      return this.denied(ctx, activeSession.id, req, command, policy, parsed, simulation);
    }

    // ── 5. Autonomy Level 3 without HIGH risk may execute ──
    if (!policy.requiresConfirmation) {
      const action = await this.persistAction(ctx, activeSession.id, {
        agent,
        utterance: req.utterance,
        intent: command.kind,
        command,
        status: 'APPROVED',
        deterministic: parsed.deterministic,
        modelId: parsed.modelId,
        policyDecision: policy,
        simulation,
        autonomyLevel: policy.autonomyLevel,
        riskLevel: policy.riskLevel,
      });
      const executed = await this.confirm(ctx, action.id, { autoApproved: true });
      return {
        action: executed.action,
        speech: executed.speech,
        requiresConfirmation: false,
      };
    }

    // ── 6. Otherwise: propose and wait for a human ─────────
    const action = await this.persistAction(ctx, activeSession.id, {
      agent,
      utterance: req.utterance,
      intent: command.kind,
      command,
      status: 'AWAITING_CONFIRMATION',
      deterministic: parsed.deterministic,
      modelId: parsed.modelId,
      policyDecision: policy,
      simulation,
      autonomyLevel: policy.autonomyLevel,
      riskLevel: policy.riskLevel,
      requiresStepUp: policy.requiresStepUp,
    });

    metrics.inc(M.agentProposed, { kind: command.kind, risk: policy.riskLevel });
    await this.bus.publish(
      'AgentActionProposed',
      { actionId: action.id, kind: command.kind, risk: policy.riskLevel },
      { tenantId: ctx.tenantId, partitionKey: ctx.userId, correlationId: ctx.correlationId },
    );

    return {
      action,
      // The confirmation sentence comes from the simulation, computed from the
      // real diff — never written by the model.
      speech:
        simulation.confirmationPrompt +
        (simulation.warnings.length ? ` ${simulation.warnings.join(' ')}` : '') +
        (policy.requiresStepUp ? ' This is a high-risk change and needs step-up authentication.' : '') +
        ' Confirm?',
      requiresConfirmation: true,
    };
  }

  /**
   * Build a proposal from a validated command: simulate, evaluate policy, and
   * persist it awaiting confirmation.
   *
   * Extracted so the conversational path and the single-shot command path
   * share exactly one implementation. There must not be two ways for a write
   * to reach the platform, or one of them will drift.
   */
  async propose(
    ctx: RequestContext,
    sessionId: string,
    command: StructuredCommand,
    utterance: string,
    opts: { deterministic: boolean; modelId: string | null } = {
      deterministic: true,
      modelId: null,
    },
  ): Promise<{ action: AgentActionView; policy: PolicyDecision; simulation: SimulationResult }> {
    const cells = await this.tools.cellsForCommand(ctx, command);
    const simulation = simulate({ command, cells });

    const policy = evaluatePolicy({
      command,
      // The agent inherits the caller's resolved permissions and property
      // scope. It never carries authority of its own — that is the reason
      // an e-commerce analyst can ask for a rate change and be refused.
      actor: {
        userId: ctx.userId,
        role: ctx.role,
        maxAutonomy: ctx.maxAutonomy,
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        permissions: ctx.permissions,
        propertyIds: ctx.propertyIds,
      },
      simulation,
      limits: this.limits,
      globalMaxAutonomy: this.globalAutonomy,
    });

    const action = await this.persistAction(ctx, sessionId, {
      agent: agentFor(command),
      utterance,
      intent: command.kind,
      command,
      status: policy.allowed ? 'AWAITING_CONFIRMATION' : 'REJECTED',
      deterministic: opts.deterministic,
      modelId: opts.modelId,
      policyDecision: policy,
      simulation,
      autonomyLevel: policy.autonomyLevel,
      riskLevel: policy.riskLevel,
      requiresStepUp: policy.requiresStepUp,
      rejectReason: policy.allowed ? undefined : policy.denialReason,
    });

    if (policy.allowed) {
      metrics.inc(M.agentProposed, { kind: command.kind, risk: policy.riskLevel });
      await this.bus.publish(
        'AgentActionProposed',
        { actionId: action.id, kind: command.kind, risk: policy.riskLevel },
        { tenantId: ctx.tenantId, partitionKey: ctx.userId, correlationId: ctx.correlationId },
      );
    } else {
      metrics.inc(M.agentDenied, { kind: command.kind });
    }

    return { action, policy, simulation };
  }

  async ensureSession(
    ctx: RequestContext,
    sessionId: string | null | undefined,
    channel: 'VOICE' | 'CHAT' | 'API',
    context: unknown,
    title?: string,
  ) {
    if (sessionId) {
      const existing = await this.prisma.agentSession.findFirst({
        where: { id: sessionId, tenantId: ctx.tenantId },
      });
      if (existing) return existing;
    }
    return this.prisma.agentSession.create({
      data: {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        channel,
        title: title?.slice(0, 120) ?? null,
        context: (context ?? {}) as any,
      },
    });
  }

  async confirm(
    ctx: RequestContext,
    actionId: string,
    opts: { autoApproved?: boolean } = {},
  ): Promise<{ action: AgentActionView; speech: string }> {
    const row = await this.prisma.agentAction.findFirst({
      where: { id: actionId, tenantId: ctx.tenantId },
    });
    if (!row) throw new DomainError({ code: 'NOT_FOUND', message: 'Action not found', owner: 'Platform' });

    if (row.status !== 'AWAITING_CONFIRMATION' && row.status !== 'APPROVED') {
      throw new DomainError({
        code: 'CONFLICT',
        message: `Action is ${row.status} and cannot be confirmed`,
        owner: 'Platform',
        details: { actionId, status: row.status },
      });
    }

    if (row.requiresStepUp && !ctx.stepUpVerified && !opts.autoApproved) {
      throw new DomainError({
        code: 'STEP_UP_REQUIRED',
        message: 'This change requires step-up authentication',
        owner: 'Platform Security',
        remediation: 'Re-authenticate with your second factor and confirm again.',
        details: { actionId, riskLevel: row.riskLevel },
      });
    }

    const command = row.command as unknown as StructuredCommand;

    await this.prisma.agentAction.update({
      where: { id: actionId },
      data: {
        status: 'EXECUTING',
        confirmedAt: new Date(),
        confirmedBy: opts.autoApproved ? `policy:auto-level-3` : ctx.userId,
      },
    });

    try {
      const result =
        command.kind === 'rollback_action'
          ? await this.rollback(ctx, command.actionId, command.reason ?? 'rollback requested')
          : await this.executor.execute(ctx, command, actionId);

      const updated = await this.prisma.agentAction.update({
        where: { id: actionId },
        data: { status: 'EXECUTED', executedAt: new Date(), result: result as any },
      });

      await this.audit.record({
        tenantId: ctx.tenantId,
        actorType: 'AGENT',
        actorId: ctx.userId,
        action: `agent.${command.kind}`,
        resourceType: 'AgentAction',
        resourceId: actionId,
        before: { status: row.status },
        after: { status: 'EXECUTED', result },
        reason: opts.autoApproved ? 'auto-approved at autonomy level 3' : 'confirmed by user',
        correlationId: ctx.correlationId,
        ip: ctx.ip,
      });

      metrics.inc(M.agentExecuted, { kind: command.kind });
      await this.bus.publish(
        'AgentActionExecuted',
        {
          actionId,
          kind: command.kind,
          userId: ctx.userId,
          affectedCells: (result as any).affectedCells ?? 0,
          result,
        },
        { tenantId: ctx.tenantId, partitionKey: ctx.userId, correlationId: ctx.correlationId },
      );

      return {
        action: toView(updated),
        speech: `${(result as any).summary} You can undo this from the audit trail.`,
      };
    } catch (err) {
      const failed = await this.prisma.agentAction.update({
        where: { id: actionId },
        data: { status: 'FAILED', error: String(err).slice(0, 1000) },
      });
      this.log.error('agent execution failed', {
        actionId,
        correlationId: ctx.correlationId,
        error: String(err),
      });
      throw err instanceof DomainError
        ? err
        : new DomainError({
            code: 'INTERNAL',
            message: 'Execution failed after confirmation',
            owner: 'Platform',
            details: { actionId, error: String(err) },
            correlationId: ctx.correlationId,
          });
    }
  }

  async reject(ctx: RequestContext, actionId: string, reason: string): Promise<AgentActionView> {
    const updated = await this.prisma.agentAction.update({
      where: { id: actionId },
      data: { status: 'REJECTED', rejectedAt: new Date(), rejectReason: reason },
    });
    await this.bus.publish(
      'AgentActionRejected',
      { actionId, reason },
      { tenantId: ctx.tenantId, partitionKey: ctx.userId, correlationId: ctx.correlationId },
    );
    return toView(updated);
  }

  /**
   * Natural-language undo.
   *
   * Nothing is deleted and no state is restored from a backup. We compute the
   * inverse command from what the action recorded and apply it as a NEW managed
   * override, so the undo is itself a versioned, auditable, undoable event.
   */
  async rollback(ctx: RequestContext, targetActionId: string, reason: string) {
    const target = await this.prisma.agentAction.findFirst({
      where: { id: targetActionId, tenantId: ctx.tenantId },
    });
    if (!target) {
      throw new DomainError({ code: 'NOT_FOUND', message: 'Action to roll back not found', owner: 'Platform' });
    }
    if (target.status !== 'EXECUTED') {
      throw new DomainError({
        code: 'CONFLICT',
        message: `Action is ${target.status}; only EXECUTED actions can be rolled back`,
        owner: 'Platform',
      });
    }
    if (target.rolledBackById) {
      throw new DomainError({
        code: 'CONFLICT',
        message: 'This action has already been rolled back',
        owner: 'Platform',
        details: { by: target.rolledBackById },
      });
    }

    const original = target.command as unknown as StructuredCommand;
    const sim = target.simulation as unknown as SimulationResult | null;

    let summary: string;
    let details: unknown;

    if (original.kind === 'create_promotion') {
      const promo = (target.result as any)?.details?.promotionId;
      if (!promo) {
        throw new DomainError({
          code: 'CONFLICT',
          message: 'Original action did not record a promotion id',
          owner: 'Platform',
        });
      }
      const cancelled = await clients.coreCommerce.post<any>(
        `/internal/core/promotions/${promo}/cancel`,
        ctx,
        { reason },
      );
      summary = `Cancelled promotion ${cancelled.code} (new version ${cancelled.version}).`;
      details = { promotionId: promo, version: cancelled.version };
    } else if (
      original.kind === 'update_rates' ||
      original.kind === 'update_availability' ||
      original.kind === 'update_restriction'
    ) {
      // The simulation captured the "before" values. Applying them back as a
      // managed override restores the prior effective state without touching
      // the external layer or the ledger's history.
      const inverse = buildInverseCommand(original, sim);
      const result = await this.executor.execute(ctx, inverse, `rollback-of-${targetActionId}`);
      summary = `Reverted: ${result.summary}`;
      details = result.details;
    } else {
      throw new DomainError({
        code: 'NOT_IMPLEMENTED',
        message: `No inverse defined for ${original.kind}`,
        owner: 'Platform',
      });
    }

    await this.prisma.agentAction.update({
      where: { id: targetActionId },
      data: { status: 'ROLLED_BACK', rolledBackById: ctx.userId },
    });
    await this.audit.record({
      tenantId: ctx.tenantId,
      actorType: 'USER',
      actorId: ctx.userId,
      action: 'agent.rolled_back',
      resourceType: 'AgentAction',
      resourceId: targetActionId,
      after: { summary, details },
      reason,
      correlationId: ctx.correlationId,
    });
    await this.bus.publish(
      'AgentActionRolledBack',
      { actionId: targetActionId, reason },
      { tenantId: ctx.tenantId, partitionKey: ctx.userId, correlationId: ctx.correlationId },
    );

    return { summary, details, affectedCells: (details as any)?.affectedCells ?? 0 };
  }

  async listActions(ctx: RequestContext, limit = 50): Promise<AgentActionView[]> {
    const rows = await this.prisma.agentAction.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
    });
    return rows.map(toView);
  }

  async getAction(ctx: RequestContext, id: string): Promise<AgentActionView> {
    const row = await this.prisma.agentAction.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!row) throw new DomainError({ code: 'NOT_FOUND', message: 'Action not found', owner: 'Platform' });
    return toView(row);
  }

  private async denied(
    ctx: RequestContext,
    sessionId: string,
    req: AgentAskInput,
    command: StructuredCommand,
    policy: PolicyDecision,
    parsed: { deterministic: boolean; modelId: string | null },
    simulation?: SimulationResult,
  ): Promise<AgentAskResponse> {
    metrics.inc(M.agentDenied, { kind: command.kind });
    const action = await this.persistAction(ctx, sessionId, {
      agent: agentFor(command),
      utterance: req.utterance,
      intent: command.kind,
      command,
      status: 'REJECTED',
      deterministic: parsed.deterministic,
      modelId: parsed.modelId,
      policyDecision: policy,
      simulation,
      autonomyLevel: policy.autonomyLevel,
      riskLevel: policy.riskLevel,
      rejectReason: policy.denialReason,
    });
    return {
      action,
      speech: `I cannot do that. ${policy.denialReason}`,
      requiresConfirmation: false,
    };
  }

  private async persistAction(
    ctx: RequestContext,
    sessionId: string,
    args: {
      agent: string;
      utterance: string;
      intent: string;
      command: StructuredCommand;
      status: string;
      deterministic: boolean;
      modelId: string | null;
      policyDecision?: PolicyDecision;
      simulation?: SimulationResult;
      autonomyLevel: number;
      riskLevel: string;
      requiresStepUp?: boolean;
      rejectReason?: string;
      result?: unknown;
    },
  ): Promise<AgentActionView> {
    const row = await this.prisma.agentAction.create({
      data: {
        sessionId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        agent: args.agent,
        modelId: args.modelId,
        deterministicIntent: args.deterministic,
        utterance: args.utterance,
        intent: args.intent,
        command: args.command as any,
        policyDecision: (args.policyDecision ?? null) as any,
        simulation: (args.simulation ?? null) as any,
        status: args.status as any,
        autonomyLevel: args.autonomyLevel,
        riskLevel: args.riskLevel as any,
        requiresStepUp: args.requiresStepUp ?? false,
        rejectReason: args.rejectReason ?? null,
        result: (args.result ?? null) as any,
        executedAt: args.status === 'EXECUTED' ? new Date() : null,
        correlationId: ctx.correlationId,
      },
    });
    return toView(row);
  }
}

function agentFor(command: StructuredCommand): string {
  switch (command.kind) {
    case 'explain_no_sales':
      return 'DiagnosticAgent';
    case 'get_ari_health':
    case 'get_connectivity_health':
      return 'ConnectivityAgent';
    case 'create_promotion':
    case 'list_promotions':
      return 'PromotionAgent';
    case 'update_rates':
      return 'RevenueAgent';
    case 'update_availability':
    case 'update_restriction':
    case 'get_availability':
      return 'PropertyAgent';
    default:
      return 'SupplyOrchestrator';
  }
}

/**
 * Inverse of a write command, derived from the simulation's recorded "before"
 * values. We use SET rather than the opposite delta on purpose: reversing a
 * +10% with a -10% does not return to the original number.
 */
function buildInverseCommand(
  original: StructuredCommand & { target?: any },
  sim: SimulationResult | null,
): StructuredCommand {
  if (!sim || !sim.samples.length) {
    throw new DomainError({
      code: 'CONFLICT',
      message: 'No recorded prior state; this action cannot be automatically reverted',
      owner: 'Platform',
      remediation: 'Restore the value manually, or replay the source feed with a reconciliation pull.',
    });
  }

  if (original.kind === 'update_rates') {
    const before = sim.projections.avgBefore;
    if (before == null) {
      throw new DomainError({
        code: 'CONFLICT',
        message: 'Prior price is unknown; cannot revert automatically',
        owner: 'Platform',
      });
    }
    return { ...original, changeType: 'SET', value: before } as StructuredCommand;
  }

  if (original.kind === 'update_availability') {
    const beforeAvg = sim.diffs.find((d) => d.field === 'available')?.before;
    return {
      ...original,
      changeType: 'SET',
      value: Number(beforeAvg ?? 0),
    } as StructuredCommand;
  }

  if (original.kind === 'update_restriction') {
    const sample = sim.samples[0].before as any;
    return {
      ...original,
      restriction: {
        open: sample.open ?? null,
        closedToArrival: sample.cta ?? null,
        closedToDeparture: sample.ctd ?? null,
        minLos: sample.minLos ?? null,
        maxLos: sample.maxLos ?? null,
      },
    } as StructuredCommand;
  }

  // Answering an agency is a commitment to somebody outside the platform. We
  // could flip a status column, but that would not un-tell the agency — so the
  // honest answer is that the platform cannot reverse it, with the name of the
  // thing that actually can.
  if (original.kind === 'respond_group_request') {
    throw new DomainError({
      code: 'CONFLICT',
      message: 'A group answer cannot be withdrawn once the agency has been told.',
      owner: 'Groups',
      remediation:
        'Send a new counter-offer, or agree the change with the agency directly. The original answer stays in the record either way.',
    });
  }

  // Configuration commands change no inventory, so "rolling back" is just
  // saving the previous values — which the operator can do from the same screen
  // with the audit entry in front of them.
  if (original.kind === 'set_group_policy' || original.kind === 'upsert_event_space') {
    throw new DomainError({
      code: 'NOT_IMPLEMENTED',
      message: `${original.kind} is configuration, not an inventory change, so there is nothing to reverse.`,
      owner: 'Platform',
      remediation: 'The previous values are on the audit entry — re-save them if they were better.',
    });
  }

  throw new DomainError({
    code: 'NOT_IMPLEMENTED',
    message: `No inverse defined for ${original.kind}`,
    owner: 'Platform',
  });
}

function toView(row: any): AgentActionView {
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
