import { decideOrder, sortForApplication } from './ordering';

const hash = (s: string) => s;

describe('ARI ordering policy', () => {
  it('applies the first event for a cell', () => {
    const d = decideOrder(
      { sourceTimestamp: new Date('2026-09-01T10:00:00Z'), payloadHash: hash('a') },
      null,
    );
    expect(d.decision).toBe('APPLY');
  });

  it('treats an identical resulting state as a duplicate even with a newer timestamp', () => {
    // Channel managers republish unchanged full snapshots constantly. Each one
    // must not bump a version or emit a change event.
    const d = decideOrder(
      { sourceTimestamp: new Date('2026-09-01T12:00:00Z'), payloadHash: hash('same') },
      {
        sourceTimestamp: new Date('2026-09-01T10:00:00Z'),
        sourceSequence: null,
        lastPayloadHash: hash('same'),
      },
    );
    expect(d.decision).toBe('DUPLICATE');
  });

  it('rejects an event whose timestamp is behind current state', () => {
    const d = decideOrder(
      { sourceTimestamp: new Date('2026-09-01T09:00:00Z'), payloadHash: hash('old') },
      {
        sourceTimestamp: new Date('2026-09-01T10:00:00Z'),
        sourceSequence: null,
        lastPayloadHash: hash('current'),
      },
    );
    expect(d.decision).toBe('OUT_OF_ORDER');
  });

  it('prefers a provider sequence over timestamps when both sides have one', () => {
    const behind = decideOrder(
      {
        sourceTimestamp: new Date('2026-09-01T23:00:00Z'),
        sourceSequence: 5n,
        payloadHash: hash('x'),
      },
      {
        sourceTimestamp: new Date('2026-09-01T10:00:00Z'),
        sourceSequence: 9n,
        lastPayloadHash: hash('y'),
      },
    );
    // Timestamp says newer, sequence says older. The sequence is authoritative.
    expect(behind.decision).toBe('OUT_OF_ORDER');
  });

  it('applies rather than drops when two events share a timestamp and differ', () => {
    // Without a sequence we cannot order these. Silently discarding a real
    // change is worse than a recorded ambiguity.
    const d = decideOrder(
      { sourceTimestamp: new Date('2026-09-01T10:00:00Z'), payloadHash: hash('b') },
      {
        sourceTimestamp: new Date('2026-09-01T10:00:00Z'),
        sourceSequence: null,
        lastPayloadHash: hash('a'),
      },
    );
    expect(d.decision).toBe('APPLY');
    expect(d.reason).toMatch(/last-writer-wins/);
  });

  it('sorts a batch so it cannot apply its own updates backwards', () => {
    const mk = (ts: string, seq?: number) =>
      ({ sourceTimestamp: new Date(ts), sourceSequence: seq ?? null }) as any;
    const sorted = sortForApplication([
      mk('2026-09-01T12:00:00Z', 3),
      mk('2026-09-01T10:00:00Z', 1),
      mk('2026-09-01T11:00:00Z', 2),
    ]);
    expect(sorted.map((e) => e.sourceSequence)).toEqual([1n, 2n, 3n].map(Number));
  });
});
