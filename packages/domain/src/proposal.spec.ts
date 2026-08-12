import { StructuredCommand } from '@wetriip/contracts';
import {
  PROPOSAL_TTL_MS,
  bindProposal,
  checkProposalFreshness,
  hashAriState,
  hashAuthority,
  hashCommand,
  hashSimulation,
} from './proposal';
import { SimCell, simulate } from './simulation';

const cells: SimCell[] = Array.from({ length: 6 }, (_, i) => ({
  stayDate: `2026-09-${String(i + 1).padStart(2, '0')}`,
  roomTypeId: 'r1',
  roomTypeCode: 'DLX',
  ratePlanId: 'rp1',
  ratePlanCode: 'BAR',
  occupancy: 2,
  currency: 'COP',
  baseAmount: 100,
  available: 5,
  open: true,
  closedToArrival: false,
  closedToDeparture: false,
  minLos: 1,
  maxLos: null,
  releaseDays: 0,
}));

const raise10: StructuredCommand = {
  kind: 'update_rates',
  target: {
    propertyId: 'p1',
    roomTypeCodes: null,
    ratePlanCodes: null,
    from: '2026-09-01',
    to: '2026-09-06',
    daysOfWeek: null,
    occupancy: null,
  },
  changeType: 'PERCENTAGE',
  value: 10,
  currency: null,
  reason: 'test',
};

const bind = (over: Partial<Parameters<typeof bindProposal>[0]> = {}) =>
  bindProposal({
    command: raise10,
    cells,
    simulation: simulate({ command: raise10, cells }),
    permissions: ['rates.write'],
    propertyIds: [],
    ...over,
  });

const current = (over: Partial<ReturnType<typeof bind>> = {}) => ({
  commandHash: hashCommand(raise10),
  stateHash: hashAriState(cells),
  simulationHash: hashSimulation(simulate({ command: raise10, cells })),
  authorityHash: hashAuthority(['rates.write'], []),
  ...over,
});

describe('hashing', () => {
  it('is stable across key order', () => {
    const a = hashCommand({ ...raise10 });
    const b = hashCommand({ ...raise10, reason: 'test' } as StructuredCommand);
    expect(a).toBe(b);
  });

  it('changes when a rate the simulation read changes', () => {
    const moved = cells.map((c, i) => (i === 0 ? { ...c, baseAmount: 150 } : c));
    expect(hashAriState(moved)).not.toBe(hashAriState(cells));
  });

  it('ignores the order rows arrive in', () => {
    expect(hashAriState([...cells].reverse())).toBe(hashAriState(cells));
  });

  it('changes when a permission is removed', () => {
    expect(hashAuthority(['rates.write'], [])).not.toBe(hashAuthority([], []));
  });

  it('ignores the order permissions arrive in', () => {
    expect(hashAuthority(['rates.write', 'agent.use'], [])).toBe(
      hashAuthority(['agent.use', 'rates.write'], []),
    );
  });
});

describe('proposal freshness', () => {
  it('passes when nothing moved', () => {
    expect(checkProposalFreshness(bind(), current()).stale).toBe(false);
  });

  it('refuses the exact TOCTOU case: the rate moved between proposal and confirm', () => {
    // Proposed against 100, so the human was shown 110.
    const bound = bind();
    // The channel manager pushed 150 in the meantime.
    const moved = cells.map((c) => ({ ...c, baseAmount: 150 }));
    const verdict = checkProposalFreshness(
      bound,
      current({ stateHash: hashAriState(moved) }),
    );
    expect(verdict.stale).toBe(true);
    expect(verdict.kind).toBe('STATE_CHANGED');
    expect(verdict.message).toMatch(/would not produce the result you approved/);
  });

  it('refuses when the caller lost the permission after proposing', () => {
    const verdict = checkProposalFreshness(
      bind(),
      current({ authorityHash: hashAuthority([], []) }),
    );
    expect(verdict.stale).toBe(true);
    expect(verdict.kind).toBe('AUTHORITY_CHANGED');
  });

  it('refuses when the stored command is not the one being confirmed', () => {
    const other = { ...raise10, value: 25 } as StructuredCommand;
    const verdict = checkProposalFreshness(bind(), current({ commandHash: hashCommand(other) }));
    expect(verdict.stale).toBe(true);
    expect(verdict.kind).toBe('COMMAND_CHANGED');
  });

  it('expires on its own after the TTL, whatever else is true', () => {
    const bound = bind();
    const later = new Date(Date.parse(bound.boundAt) + PROPOSAL_TTL_MS + 1);
    const verdict = checkProposalFreshness(bound, current(), later);
    expect(verdict.stale).toBe(true);
    expect(verdict.kind).toBe('EXPIRED');
  });

  it('reports authority drift before state drift, because it is the harder no', () => {
    const moved = cells.map((c) => ({ ...c, baseAmount: 150 }));
    const verdict = checkProposalFreshness(
      bind(),
      current({ authorityHash: hashAuthority([], []), stateHash: hashAriState(moved) }),
    );
    expect(verdict.kind).toBe('AUTHORITY_CHANGED');
  });
});
