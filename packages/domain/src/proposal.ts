import { createHash } from 'node:crypto';
import { Permission, SimulationResult, StructuredCommand } from '@wetriip/contracts';
import { SimCell } from './simulation';

/**
 * Binding a proposal to the state it was computed on.
 *
 * The confirm flow had a Time-Of-Check / Time-Of-Use hole wide enough to change
 * what a human agreed to:
 *
 *   10:00  rate is 100. Simulation of +10% projects 110. The user is shown 110.
 *   10:03  the channel manager pushes 150.
 *   10:05  the user presses Confirm. Execution re-reads 150 and applies +10%.
 *          The rate becomes 165.
 *
 * Nobody approved 165. The command was faithfully executed and the outcome was
 * still wrong, because a percentage is a function of state and the state moved.
 *
 * The fix is not to freeze the numbers and apply them blind — stale numbers
 * would be worse. It is to make the proposal carry a fingerprint of what it was
 * computed on, re-take that fingerprint at confirmation, and refuse when they
 * differ. The human then sees the new projection and decides again.
 */

function sha(input: string): string {
  return createHash('sha256').update(input).digest('base64url').slice(0, 32);
}

/** Stable stringify: key order must not change the hash. */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${k}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashCommand(command: StructuredCommand): string {
  return sha(canonical(command));
}

/**
 * The state fingerprint.
 *
 * Only the fields a simulation actually reads are included. Hashing the whole
 * row would make an unrelated column bump invalidate every open proposal, and a
 * staleness check that fires constantly is a staleness check people learn to
 * click through.
 */
export function hashAriState(cells: SimCell[]): string {
  const rows = cells
    .map((c) =>
      [
        c.stayDate,
        c.roomTypeId,
        c.ratePlanId,
        c.occupancy,
        c.baseAmount ?? '',
        c.available,
        c.open ? 1 : 0,
        c.closedToArrival ? 1 : 0,
        c.closedToDeparture ? 1 : 0,
        c.minLos,
        c.maxLos ?? '',
      ].join('|'),
    )
    .sort();
  return sha(rows.join('\n'));
}

/**
 * What the human was actually shown. A simulation whose projected numbers
 * changed is a different proposal even if the command is byte-identical.
 */
export function hashSimulation(sim: SimulationResult | null): string {
  if (!sim) return sha('none');
  return sha(
    canonical({
      blastRadius: sim.blastRadius,
      projections: sim.projections,
      diffs: sim.diffs,
      blockers: sim.blockers,
    }),
  );
}

/** Authority as it stood when the proposal was made. */
export function hashAuthority(permissions: readonly Permission[], propertyIds: readonly string[]): string {
  return sha(canonical({ p: [...permissions].sort(), s: [...propertyIds].sort() }));
}

export interface ProposalBinding {
  commandHash: string;
  stateHash: string;
  simulationHash: string;
  authorityHash: string;
  boundAt: string;
  expiresAt: string;
}

/** How long a proposal may sit before it must be recomputed regardless. */
export const PROPOSAL_TTL_MS = 15 * 60_000;

export function bindProposal(args: {
  command: StructuredCommand;
  cells: SimCell[];
  simulation: SimulationResult | null;
  permissions: readonly Permission[];
  propertyIds: readonly string[];
  now?: Date;
}): ProposalBinding {
  const now = args.now ?? new Date();
  return {
    commandHash: hashCommand(args.command),
    stateHash: hashAriState(args.cells),
    simulationHash: hashSimulation(args.simulation),
    authorityHash: hashAuthority(args.permissions, args.propertyIds),
    boundAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PROPOSAL_TTL_MS).toISOString(),
  };
}

export type StalenessKind = 'EXPIRED' | 'STATE_CHANGED' | 'AUTHORITY_CHANGED' | 'COMMAND_CHANGED';

export interface StalenessVerdict {
  stale: boolean;
  kind?: StalenessKind;
  /** What to tell the human, in terms of what actually moved. */
  message?: string;
}

/**
 * Compare a stored binding against the world as it is now.
 *
 * Each kind of drift gets its own answer, because they need different actions:
 * expired means "look again", state changed means "the numbers moved", and
 * authority changed means "you no longer may".
 */
export function checkProposalFreshness(
  bound: ProposalBinding,
  current: Omit<ProposalBinding, 'boundAt' | 'expiresAt'>,
  now: Date = new Date(),
): StalenessVerdict {
  if (new Date(bound.expiresAt).getTime() <= now.getTime()) {
    return {
      stale: true,
      kind: 'EXPIRED',
      message: 'This proposal is older than 15 minutes. Ask again so the numbers are current.',
    };
  }
  if (bound.commandHash !== current.commandHash) {
    return {
      stale: true,
      kind: 'COMMAND_CHANGED',
      message: 'The stored command no longer matches the one being confirmed.',
    };
  }
  if (bound.authorityHash !== current.authorityHash) {
    return {
      stale: true,
      kind: 'AUTHORITY_CHANGED',
      message:
        'Your permissions or property scope changed after this was proposed. It must be re-evaluated before it can run.',
    };
  }
  if (bound.stateHash !== current.stateHash) {
    return {
      stale: true,
      kind: 'STATE_CHANGED',
      message:
        'Rates or availability changed since this was proposed, so applying it now would not produce the result you approved.',
    };
  }
  return { stale: false };
}
