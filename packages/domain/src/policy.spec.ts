import { Role, StructuredCommand } from '@wetriip/contracts';
import { resolvePermissions } from './permissions';
import { evaluatePolicy } from './policy';
import { simulate } from './simulation';

const cells = Array.from({ length: 40 }, (_, i) => ({
  stayDate: `2026-09-${String((i % 28) + 1).padStart(2, '0')}`,
  roomTypeId: 'r1',
  roomTypeCode: 'DLX',
  ratePlanId: 'rp1',
  ratePlanCode: 'BAR',
  occupancy: 2,
  currency: 'COP',
  baseAmount: 600000,
  available: 5,
  open: true,
  closedToArrival: false,
  closedToDeparture: false,
  minLos: 1,
  maxLos: null,
  releaseDays: 0,
}));

/**
 * Actors carry RESOLVED permissions, exactly as the gateway hands them over.
 * Building them through the same resolver the runtime uses is deliberate: a
 * fixture that hand-lists permissions would keep passing after the role bundle
 * changed underneath it.
 */
function actor(role: Role, maxAutonomy: 1 | 2 | 3 = 2) {
  return {
    userId: 'u1',
    role,
    maxAutonomy,
    organizationId: 'o1',
    tenantId: 't1',
    permissions: resolvePermissions(role),
    propertyIds: [] as string[],
  };
}

const revenueManager = actor('REVENUE_MANAGER');

const raise10: StructuredCommand = {
  kind: 'update_rates',
  target: {
    propertyId: 'p1',
    roomTypeCodes: null,
    ratePlanCodes: null,
    from: '2026-09-01',
    to: '2026-09-30',
    daysOfWeek: null,
    occupancy: null,
  },
  changeType: 'PERCENTAGE',
  value: 10,
  currency: null,
  reason: 'test',
};

describe('Policy engine', () => {
  it('allows an in-limit change but still demands confirmation at autonomy 2', () => {
    const sim = simulate({ command: raise10, cells });
    const decision = evaluatePolicy({
      command: raise10,
      actor: revenueManager,
      simulation: sim,
      globalMaxAutonomy: 3,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.requiresConfirmation).toBe(true);
  });

  it('denies a change beyond the tenant rate limit', () => {
    const cmd = { ...raise10, value: 45 } as StructuredCommand;
    const decision = evaluatePolicy({
      command: cmd,
      actor: revenueManager,
      simulation: simulate({ command: cmd, cells }),
      globalMaxAutonomy: 3,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.denialReason).toMatch(/MAX_RATE_DELTA/);
    expect(decision.riskLevel).toBe('HIGH');
  });

  it('never lets the agent exceed the invoking user', () => {
    // A reservation agent has no grant for update_rates, so the agent acting
    // on their behalf has none either.
    const decision = evaluatePolicy({
      command: raise10,
      actor: actor('RESERVATION_AGENT'),
      simulation: simulate({ command: raise10, cells }),
      globalMaxAutonomy: 3,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.checks.find((c) => c.code === 'PERMISSION')?.passed).toBe(false);
  });

  it('refuses every write at autonomy level 1 (Observe)', () => {
    const decision = evaluatePolicy({
      command: raise10,
      actor: actor('REVENUE_MANAGER', 1),
      simulation: simulate({ command: raise10, cells }),
      globalMaxAutonomy: 3,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.checks.find((c) => c.code === 'AUTONOMY')?.passed).toBe(false);
  });

  it('allows a level-3 actor to execute a low-risk change without confirmation', () => {
    const small = { ...raise10, value: 3 } as StructuredCommand;
    const decision = evaluatePolicy({
      command: small,
      actor: actor('HOTEL_OWNER', 3),
      simulation: simulate({ command: small, cells }),
      globalMaxAutonomy: 3,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.requiresConfirmation).toBe(false);
  });

  it('still stops a level-3 actor on a HIGH risk change', () => {
    const close: StructuredCommand = {
      kind: 'update_restriction',
      target: raise10.target,
      restriction: { open: false },
      reason: 'closing everything',
    };
    const decision = evaluatePolicy({
      command: close,
      actor: actor('HOTEL_OWNER', 3),
      simulation: simulate({ command: close, cells }),
      globalMaxAutonomy: 3,
    });
    expect(decision.riskLevel).toBe('HIGH');
    expect(decision.requiresConfirmation).toBe(true);
    expect(decision.requiresStepUp).toBe(true);
  });

  it('caps effective autonomy at the platform ceiling', () => {
    const small = { ...raise10, value: 3 } as StructuredCommand;
    const decision = evaluatePolicy({
      command: small,
      actor: actor('HOTEL_OWNER', 3),
      simulation: simulate({ command: small, cells }),
      globalMaxAutonomy: 2,
    });
    expect(decision.autonomyLevel).toBe(2);
    expect(decision.requiresConfirmation).toBe(true);
  });

  it('reads a read command as Level 1 with no confirmation', () => {
    const decision = evaluatePolicy({
      command: { kind: 'explain_no_sales', propertyId: 'p1' } as StructuredCommand,
      actor: actor('REVENUE_MANAGER', 1),
      simulation: null,
      globalMaxAutonomy: 1,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.requiresConfirmation).toBe(false);
  });
});

describe('Simulation', () => {
  it('computes a blast radius and a confirmation sentence from real numbers', () => {
    const sim = simulate({ command: raise10, cells });
    expect(sim.blastRadius.ariCells).toBe(40);
    expect(sim.projections.avgBefore).toBe(600000);
    expect(sim.projections.avgAfter).toBe(660000);
    expect(sim.projections.adrDeltaPct).toBe(10);
    expect(sim.confirmationPrompt).toMatch(/40 ARI cells/);
  });

  it('blocks a change that would drive prices to zero or below', () => {
    const cmd = { ...raise10, changeType: 'ABSOLUTE', value: -700000 } as StructuredCommand;
    const sim = simulate({ command: cmd, cells });
    expect(sim.feasible).toBe(false);
    expect(sim.blockers.join(' ')).toMatch(/zero or below/);
  });

  it('refuses to invent a revenue projection without a demand signal', () => {
    const sim = simulate({ command: raise10, cells });
    expect(sim.projections.estimatedRevenueImpact).toBeNull();

    const withDemand = simulate({ command: raise10, cells, expectedRoomNights: 100 });
    expect(withDemand.projections.estimatedRevenueImpact).toBe(6_000_000);
  });

  it('warns when closing inventory', () => {
    const sim = simulate({
      command: {
        kind: 'update_restriction',
        target: raise10.target,
        restriction: { open: false },
      } as StructuredCommand,
      cells,
    });
    expect(sim.warnings.join(' ')).toMatch(/disappear from search/);
  });
});
