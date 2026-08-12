import { EffectiveAriRow } from '@wetriip/contracts';
import { evaluateSellability } from './sellability';

const now = new Date('2026-08-11T12:00:00Z');

function cell(overrides: Partial<EffectiveAriRow> = {}): EffectiveAriRow {
  return {
    tenantId: 't1',
    propertyId: 'p1',
    roomTypeId: 'r1',
    ratePlanId: 'rp1',
    stayDate: '2026-09-10',
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
    bookingGap: 0,
    freshnessSeconds: 120,
    stale: false,
    explanation: { fields: {}, layersPresent: ['EXTERNAL'], notes: [] },
    externalVersion: 1,
    managedVersion: 0,
    version: 1,
    computedAt: now.toISOString(),
    ...overrides,
  };
}

const baseCtx = {
  now,
  freshnessSlaSeconds: 3600,
  propertyStatus: 'APPROVED',
  mappingActive: true,
  contract: {
    id: 'c1',
    status: 'PUBLISHED',
    validFrom: '2026-01-01',
    validTo: '2026-12-31',
    markets: ['CO'],
    channels: ['B2B'],
    propertyIds: [],
  },
  buyer: { organizationId: 'o1', market: 'CO', channel: 'B2B' },
  stay: {
    checkIn: '2026-09-10',
    checkOut: '2026-09-13',
    nights: 3,
    isArrival: true,
    isDeparture: false,
  },
};

describe('Sellability engine', () => {
  it('is sellable when every predicate holds', () => {
    const r = evaluateSellability(cell(), baseCtx);
    expect(r.sellable).toBe(true);
    expect(r.failedCodes).toEqual([]);
  });

  it('reports ALL failing predicates, not just the first', () => {
    const r = evaluateSellability(cell({ available: 0, open: false, stale: true }), {
      ...baseCtx,
      propertyStatus: 'PENDING_APPROVAL',
    });
    expect(r.sellable).toBe(false);
    expect(r.failedCodes).toEqual(
      expect.arrayContaining(['PROPERTY_APPROVED', 'ARI_FRESH', 'AVAILABILITY_POSITIVE', 'PROPERTY_OPEN']),
    );
  });

  it('blocks a stay shorter than minLOS and says by how much', () => {
    const r = evaluateSellability(cell({ minLos: 5 }), baseCtx);
    expect(r.failedCodes).toContain('RESTRICTIONS_SATISFIED');
    const p = r.predicates.find((x) => x.code === 'RESTRICTIONS_SATISFIED')!;
    expect((p.evidence as any).failures.join(' ')).toMatch(/minLOS 5 > 3 nights/);
  });

  it('blocks closed-to-arrival only on the arrival night', () => {
    const arrival = evaluateSellability(cell({ closedToArrival: true }), baseCtx);
    expect(arrival.failedCodes).toContain('RESTRICTIONS_SATISFIED');

    const midStay = evaluateSellability(cell({ closedToArrival: true }), {
      ...baseCtx,
      stay: { ...baseCtx.stay, isArrival: false },
    });
    expect(midStay.failedCodes).not.toContain('RESTRICTIONS_SATISFIED');
  });

  it('marks a predicate unevaluated rather than passing it when input is missing', () => {
    const r = evaluateSellability(cell(), { ...baseCtx, stay: null });
    const p = r.predicates.find((x) => x.code === 'RESTRICTIONS_SATISFIED')!;
    expect(p.evaluated).toBe(false);
    expect(p.ok).toBe(false);
  });

  it('excludes a buyer outside the contract market and explains why', () => {
    const r = evaluateSellability(cell(), {
      ...baseCtx,
      buyer: { organizationId: 'o1', market: 'MX', channel: 'B2B' },
    });
    expect(r.failedCodes).toContain('BUYER_ELIGIBLE');
    const p = r.predicates.find((x) => x.code === 'BUYER_ELIGIBLE')!;
    expect((p.evidence as any).reasons.join(' ')).toMatch(/market MX not in contract markets/);
  });

  it('quarantines an invalid price rather than selling it', () => {
    const r = evaluateSellability(cell({ baseAmount: 0 }), baseCtx);
    expect(r.failedCodes).toContain('PRICE_VALID');
  });

  it('attaches an owner and a remediation to each failure', () => {
    const r = evaluateSellability(cell({ stale: true }), baseCtx);
    const p = r.predicates.find((x) => x.code === 'ARI_FRESH')!;
    expect(p.owner).toBe('Connectivity');
    expect(p.remediation).toMatch(/reconciliation pull/);
    expect(p.autoFixable).toBe(true);
  });
});
