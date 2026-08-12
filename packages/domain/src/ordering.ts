import { NormalizedAriEvent } from '@wetriip/contracts';

/**
 * Out-of-order and duplicate policy.
 *
 * At-least-once transport is a given. Exactly-once EFFECT is achieved here:
 * an event that is older than what we already applied to a cell is recorded
 * in the ledger (we never drop evidence) but does not move the cell state.
 *
 * The audit rated "events out of order overwrite newer state" as a P1 risk.
 * This function is the control.
 */
export type OrderDecision = 'APPLY' | 'DUPLICATE' | 'OUT_OF_ORDER';

export interface CellOrderState {
  sourceTimestamp: Date | null;
  sourceSequence: bigint | null;
  lastPayloadHash: string | null;
}

export function decideOrder(
  incoming: {
    sourceTimestamp: Date;
    sourceSequence?: bigint | number | null;
    payloadHash: string;
  },
  current: CellOrderState | null,
): { decision: OrderDecision; reason: string } {
  if (!current || (!current.sourceTimestamp && current.sourceSequence == null)) {
    return { decision: 'APPLY', reason: 'first event for cell' };
  }

  // Identical payload for a cell we already hold: a redelivery, not a change.
  if (current.lastPayloadHash && current.lastPayloadHash === incoming.payloadHash) {
    return { decision: 'DUPLICATE', reason: 'payload hash matches current cell state' };
  }

  const inSeq =
    incoming.sourceSequence == null ? null : BigInt(incoming.sourceSequence as any);

  // A provider-supplied sequence is authoritative when both sides have one.
  if (inSeq != null && current.sourceSequence != null) {
    if (inSeq > current.sourceSequence) return { decision: 'APPLY', reason: 'sequence advanced' };
    if (inSeq === current.sourceSequence)
      return { decision: 'DUPLICATE', reason: 'same source sequence' };
    return {
      decision: 'OUT_OF_ORDER',
      reason: `sequence ${inSeq} is behind current ${current.sourceSequence}`,
    };
  }

  if (current.sourceTimestamp) {
    const inMs = incoming.sourceTimestamp.getTime();
    const curMs = current.sourceTimestamp.getTime();
    if (inMs > curMs) return { decision: 'APPLY', reason: 'source timestamp advanced' };
    if (inMs === curMs) {
      // Same instant, different payload. Without a sequence we cannot order
      // these, so we apply and flag: silently discarding a real change is
      // worse than a recorded ambiguity.
      return { decision: 'APPLY', reason: 'same timestamp, differing payload (last-writer-wins)' };
    }
    return {
      decision: 'OUT_OF_ORDER',
      reason: `source timestamp ${incoming.sourceTimestamp.toISOString()} is behind current ${current.sourceTimestamp.toISOString()}`,
    };
  }

  return { decision: 'APPLY', reason: 'no comparable ordering information' };
}

/**
 * Sort a batch into a safe application order before touching any cell, so a
 * single payload carrying several updates for the same date cannot apply them
 * backwards.
 */
export function sortForApplication(events: NormalizedAriEvent[]): NormalizedAriEvent[] {
  return [...events].sort((a, b) => {
    const t = a.sourceTimestamp.getTime() - b.sourceTimestamp.getTime();
    if (t !== 0) return t;
    const as = a.sourceSequence == null ? 0n : BigInt(a.sourceSequence as any);
    const bs = b.sourceSequence == null ? 0n : BigInt(b.sourceSequence as any);
    if (as !== bs) return as < bs ? -1 : 1;
    return 0;
  });
}
