import {
  ALWAYS_HIGH_RISK,
  AutonomyLevel,
  Permission,
  PolicyDecision,
  RiskLevel,
  SimulationResult,
  StructuredCommand,
  isReadCommand,
} from '@wetriip/contracts';
import { COMMAND_PERMISSIONS } from './permissions';

/**
 * Policy Engine.
 *
 * The gate between "the agent understood something" and "the platform did
 * something". It runs AFTER simulation, because half of these limits are only
 * knowable once you know the blast radius.
 *
 * Three independent things must all agree before a write happens:
 *   1. the USER may perform this action (RBAC)
 *   2. the AGENT is allowed this much autonomy (never more than the user's own)
 *   3. the CHANGE is inside the tenant's hard numeric limits
 *
 * Rule 2 is the one people get wrong. An agent invoked by a reservation agent
 * cannot do what a revenue manager could — the agent inherits the caller's
 * permissions, it does not carry its own.
 */

export interface PolicyLimits {
  maxDiscountPct: number;
  maxRateDeltaPct: number;
  maxBlastRadiusCells: number;
  /** Below this, a rate change is refused outright. Null disables the floor. */
  floorRate?: number | null;
  floorRateCurrency?: string | null;
}

export const DEFAULT_LIMITS: PolicyLimits = {
  maxDiscountPct: 25,
  maxRateDeltaPct: 20,
  maxBlastRadiusCells: 5000,
  floorRate: null,
  floorRateCurrency: null,
};

export interface PolicyActor {
  userId: string;
  role: string;
  /** Autonomy ceiling for this user. */
  maxAutonomy: AutonomyLevel;
  organizationId: string;
  tenantId: string;
  /** Resolved permissions: role bundle + grants − revokes. */
  permissions: Permission[];
  /** Empty means every property in their organization. */
  propertyIds?: string[];
}

/**
 * Authority is a permission, not a role.
 *
 * A hotel can hand its e-commerce analyst `rates.write` for one week without
 * inventing a new role, and can take `availability.write` away from a
 * reservation agent who should not have it. The role is only the default
 * bundle; this reads the resolved set.
 */
function actorMayIssue(actor: PolicyActor, kind: StructuredCommand['kind']): boolean {
  const required = COMMAND_PERMISSIONS[kind];
  if (!required) return false;
  return (actor.permissions ?? []).includes(required);
}

export function assessRisk(
  command: StructuredCommand,
  sim: SimulationResult | null,
  limits: PolicyLimits,
): RiskLevel {
  if (ALWAYS_HIGH_RISK.includes(command.kind)) return 'HIGH';
  if (isReadCommand(command.kind)) return 'LOW';

  const cells = sim?.blastRadius.ariCells ?? 0;
  if (cells > limits.maxBlastRadiusCells) return 'HIGH';

  if (command.kind === 'update_rates') {
    const pct =
      command.changeType === 'PERCENTAGE'
        ? Math.abs(command.value)
        : Math.abs(sim?.projections.adrDeltaPct ?? 0);
    if (pct > limits.maxRateDeltaPct) return 'HIGH';
    if (pct > limits.maxRateDeltaPct / 2 || cells > limits.maxBlastRadiusCells / 4) return 'MEDIUM';
    return 'LOW';
  }

  if (command.kind === 'create_promotion') {
    const d = command.definition.discount;
    const pct = d.type === 'PERCENTAGE' ? d.value : 0;
    if (pct > limits.maxDiscountPct) return 'HIGH';
    return pct > limits.maxDiscountPct / 2 ? 'MEDIUM' : 'LOW';
  }

  if (command.kind === 'update_promotion') {
    const pct = command.changes.discountValue ?? 0;
    if (pct > limits.maxDiscountPct) return 'HIGH';
    return pct > limits.maxDiscountPct / 2 ? 'MEDIUM' : 'LOW';
  }

  // Configuration, not inventory: nothing is oversold if it is wrong, and the
  // hotel sees the result immediately. Loading a salón is genuinely low risk.
  if (command.kind === 'upsert_event_space') return 'LOW';

  if (command.kind === 'set_group_policy') {
    // A floor rate and a comp rule decide what the hotel will accept for
    // months of group business. Getting it wrong is not visible until a
    // negotiation has already been settled on it.
    const touchesMoney = command.floorRatePerNight != null || (command.benefits?.length ?? 0) > 0;
    return touchesMoney ? 'MEDIUM' : 'LOW';
  }

  if (command.kind === 'set_promotion_status') {
    // Cancelling is final for that promotion; pausing is reversible.
    return command.status === 'CANCELLED' ? 'MEDIUM' : 'LOW';
  }

  if (command.kind === 'update_restriction') {
    // Closing inventory is how a hotel disappears from search without noticing.
    if (command.restriction.open === false) return 'HIGH';
    return cells > limits.maxBlastRadiusCells / 4 ? 'MEDIUM' : 'LOW';
  }

  if (command.kind === 'update_availability') {
    if (command.changeType === 'SET' && command.value === 0) return 'HIGH';
    return cells > limits.maxBlastRadiusCells / 4 ? 'MEDIUM' : 'LOW';
  }

  return 'MEDIUM';
}

export function evaluatePolicy(args: {
  command: StructuredCommand;
  actor: PolicyActor;
  simulation: SimulationResult | null;
  limits?: Partial<PolicyLimits>;
  /** Platform-wide ceiling from configuration. */
  globalMaxAutonomy: AutonomyLevel;
}): PolicyDecision {
  const limits: PolicyLimits = { ...DEFAULT_LIMITS, ...(args.limits ?? {}) };
  const { command, actor, simulation } = args;
  const checks: PolicyDecision['checks'] = [];

  // 1 — Permission. The agent inherits the caller's authority and never
  //     carries its own, so this is the same check a REST call would face.
  const required = COMMAND_PERMISSIONS[command.kind];
  const rbacOk = actorMayIssue(actor, command.kind);
  checks.push({
    code: 'PERMISSION',
    label: `Requires ${required}`,
    passed: rbacOk,
    detail: rbacOk
      ? undefined
      : `Your role (${actor.role}) does not include ${required}. A general manager can grant it individually.`,
  });

  // 1b — Property scope. WHAT you may do is a permission; WHICH properties you
  //      may do it to is a scope, and they are checked separately.
  const targetProperty =
    'target' in command
      ? command.target.propertyId
      : command.kind === 'create_promotion'
        ? command.definition.scope.propertyId
        : 'propertyId' in command
          ? (command as any).propertyId
          : null;

  if (targetProperty && (actor.propertyIds?.length ?? 0) > 0) {
    const inScope = actor.propertyIds!.includes(targetProperty);
    checks.push({
      code: 'PROPERTY_SCOPE',
      label: 'Property is inside your access scope',
      passed: inScope,
      detail: inScope
        ? undefined
        : 'Your access is limited to specific properties and this is not one of them.',
    });
  }

  // 2 — Autonomy. The agent can never exceed the invoking user.
  const effectiveAutonomy = Math.min(actor.maxAutonomy, args.globalMaxAutonomy) as AutonomyLevel;
  const isRead = isReadCommand(command.kind);
  const autonomyOk = isRead || effectiveAutonomy >= 2;
  checks.push({
    code: 'AUTONOMY',
    label: isRead ? 'Read command (Level 1 Observe)' : 'Write command requires Level 2+',
    passed: autonomyOk,
    limit: effectiveAutonomy,
    actual: isRead ? 1 : 2,
    detail: autonomyOk
      ? undefined
      : 'Agent is in Observe mode; it may explain but not change anything.',
  });

  // 3 — Simulation feasibility
  if (!isRead) {
    checks.push({
      code: 'SIMULATION',
      label: 'Simulation produced a feasible plan',
      passed: !!simulation?.feasible,
      detail: simulation?.blockers?.length ? simulation.blockers.join('; ') : undefined,
    });
  }

  // 4 — Numeric hard gates
  if (command.kind === 'create_promotion' || command.kind === 'update_promotion') {
    const pct =
      command.kind === 'create_promotion'
        ? command.definition.discount.type === 'PERCENTAGE'
          ? command.definition.discount.value
          : 0
        : (command.changes.discountValue ?? 0);
    checks.push({
      code: 'MAX_DISCOUNT',
      label: 'Discount within tenant limit',
      passed: pct <= limits.maxDiscountPct,
      limit: `${limits.maxDiscountPct}%`,
      actual: `${pct}%`,
    });
  }

  if (command.kind === 'update_rates') {
    const pct =
      command.changeType === 'PERCENTAGE'
        ? Math.abs(command.value)
        : Math.abs(simulation?.projections.adrDeltaPct ?? 0);
    checks.push({
      code: 'MAX_RATE_DELTA',
      label: 'Rate movement within tenant limit',
      passed: pct <= limits.maxRateDeltaPct,
      limit: `${limits.maxRateDeltaPct}%`,
      actual: `${pct.toFixed(2)}%`,
    });

    if (limits.floorRate != null) {
      const minAfter = simulation?.projections.minAfter ?? null;
      const floorOk = minAfter == null || minAfter >= limits.floorRate;
      checks.push({
        code: 'FLOOR_RATE',
        label: 'No rate falls below the configured floor',
        passed: floorOk,
        limit: `${limits.floorRate} ${limits.floorRateCurrency ?? ''}`.trim(),
        actual: minAfter == null ? 'n/a' : String(minAfter),
      });
    }
  }

  if (!isRead) {
    const cells = simulation?.blastRadius.ariCells ?? 0;
    checks.push({
      code: 'BLAST_RADIUS',
      label: 'Affected ARI cells within limit',
      passed: cells <= limits.maxBlastRadiusCells,
      limit: limits.maxBlastRadiusCells,
      actual: cells,
    });
  }

  const riskLevel = assessRisk(command, simulation, limits);
  const failed = checks.filter((c) => !c.passed);
  const allowed = failed.length === 0;

  // At Level 3 the agent may execute without asking — except for HIGH risk,
  // which always stops for a human. "Autonomous" never means "unsupervised
  // when it matters".
  const requiresConfirmation = allowed && !isRead && (effectiveAutonomy < 3 || riskLevel === 'HIGH');
  const requiresStepUp = allowed && !isRead && riskLevel === 'HIGH';

  return {
    allowed,
    requiresConfirmation,
    requiresStepUp,
    autonomyLevel: effectiveAutonomy,
    riskLevel,
    checks,
    denialReason: allowed
      ? undefined
      : failed.map((f) => f.detail || `${f.code} failed (limit ${f.limit}, actual ${f.actual})`).join(' · '),
  };
}
