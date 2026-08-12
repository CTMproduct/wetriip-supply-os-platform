import { EffectiveAriRow } from '@wetriip/contracts';
import {
  BookingFact,
  PartnerFact,
  advise,
  computeMetrics,
  computePartnerProduction,
} from './revenue';

const now = new Date('2026-09-01T12:00:00Z');

function booking(over: Partial<BookingFact> = {}): BookingFact {
  return {
    id: `b${Math.random()}`,
    buyerOrgId: 'org-a',
    checkIn: '2026-09-10',
    checkOut: '2026-09-12',
    nights: 2,
    amount: 400000,
    currencyCode: 'COP',
    status: 'CONFIRMED',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    ...over,
  };
}

function cell(over: Partial<EffectiveAriRow> = {}): EffectiveAriRow {
  return {
    tenantId: 't',
    propertyId: 'p1',
    roomTypeId: 'r1',
    ratePlanId: 'rp1',
    stayDate: '2026-09-10',
    occupancy: 2,
    currency: 'COP',
    baseAmount: 200000,
    available: 5,
    open: true,
    closedToArrival: false,
    closedToDeparture: false,
    minLos: 1,
    maxLos: null,
    releaseDays: 0,
    bookingGap: 0,
    freshnessSeconds: 60,
    stale: false,
    explanation: { fields: {}, layersPresent: ['EXTERNAL'], notes: [] },
    externalVersion: 1,
    managedVersion: 0,
    version: 1,
    computedAt: now.toISOString(),
    ...over,
  };
}

const baseArgs = {
  propertyId: 'p1',
  propertyName: 'Hotel Test',
  currency: 'COP',
  window: { from: '2026-09-01', to: '2026-09-11' },
  roomInventory: [{ roomTypeId: 'r1', quantity: 10 }],
  cells: [] as EffectiveAriRow[],
  offers: [],
  searches: 0,
  now,
};

describe('Revenue metrics', () => {
  it('computes occupancy, ADR and RevPAR from capacity, not from open inventory', () => {
    // 10 rooms x 10 nights = 100 room nights of CAPACITY, whatever the channel
    // manager left open.
    const m = computeMetrics({
      ...baseArgs,
      bookings: [booking(), booking(), booking(), booking(), booking()],
    });

    expect(m.roomNightsAvailable).toBe(100);
    expect(m.roomNightsSold).toBe(10);
    expect(m.roomRevenue).toBe(2_000_000);
    expect(m.occupancy).toBeCloseTo(0.1, 3);
    expect(m.adr).toBe(200000);
    expect(m.revpar).toBe(20000);
  });

  it('derives RevPAR from revenue and capacity rather than multiplying rounded figures', () => {
    const m = computeMetrics({ ...baseArgs, bookings: [booking({ amount: 333333, nights: 3 })] });
    expect(m.revpar).toBe(Math.round((333333 / 100) * 100) / 100);
  });

  it('excludes cancelled bookings from production', () => {
    const m = computeMetrics({
      ...baseArgs,
      bookings: [booking(), booking({ status: 'CANCELLED', amount: 999999 })],
    });
    expect(m.bookingCount).toBe(1);
    expect(m.roomRevenue).toBe(400000);
  });

  it('grades confidence by sample size', () => {
    expect(computeMetrics({ ...baseArgs, bookings: [] }).confidence).toBe('NONE');
    expect(computeMetrics({ ...baseArgs, bookings: [booking()] }).confidence).toBe('LOW');
    expect(
      computeMetrics({ ...baseArgs, bookings: Array.from({ length: 20 }, () => booking()) })
        .confidence,
    ).toBe('MEDIUM');
    expect(
      computeMetrics({ ...baseArgs, bookings: Array.from({ length: 90 }, () => booking()) })
        .confidence,
    ).toBe('HIGH');
  });

  it('reports how many bookings needed an FX conversion', () => {
    const m = computeMetrics({
      ...baseArgs,
      bookings: [booking(), booking({ converted: true })],
      fxSource: 'static-dev-table',
    });
    expect(m.fxConvertedBookings).toBe(1);
    expect(m.fxSource).toBe('static-dev-table');
  });

  it('buckets lead time from booking date to arrival', () => {
    const m = computeMetrics({
      ...baseArgs,
      bookings: [
        booking({ createdAt: new Date('2026-09-09T00:00:00Z') }), // 1 day
        booking({ createdAt: new Date('2026-08-01T00:00:00Z') }), // 40 days
      ],
    });
    expect(m.leadTimeBuckets.find((b) => b.label === '0-3 days')?.bookings).toBe(1);
    expect(m.leadTimeBuckets.find((b) => b.label === '22-45 days')?.bookings).toBe(1);
  });
});

describe('Partner production', () => {
  const partners: PartnerFact[] = [
    {
      organizationId: 'org-a',
      name: 'Agencia A',
      type: 'AGENCY',
      country: 'CO',
      contractCode: 'A',
      commissionPct: 20,
      markupPct: null,
    },
    {
      organizationId: 'org-b',
      name: 'Mayorista B',
      type: 'WHOLESALER',
      country: 'MX',
      contractCode: 'B',
      commissionPct: 5,
      markupPct: null,
    },
  ];

  it('ranks gross production but exposes net, which can rank the other way', () => {
    const rows = computePartnerProduction(
      [
        booking({ buyerOrgId: 'org-a', amount: 1_000_000, nights: 2 }),
        booking({ buyerOrgId: 'org-b', amount: 900_000, nights: 2 }),
      ],
      partners,
    );

    // Gross puts A first...
    expect(rows[0].organizationId).toBe('org-a');
    // ...but after commission B is worth more per room night, which is the
    // number a revenue manager should actually decide on.
    const a = rows.find((r) => r.organizationId === 'org-a')!;
    const b = rows.find((r) => r.organizationId === 'org-b')!;
    expect(a.netRevenue).toBe(800_000);
    expect(b.netRevenue).toBe(855_000);
    expect(b.netRevenue! / b.roomNights).toBeGreaterThan(a.netRevenue! / a.roomNights);
  });

  it('computes cancellation rate over all bookings, not just confirmed ones', () => {
    const rows = computePartnerProduction(
      [
        booking({ buyerOrgId: 'org-a' }),
        booking({ buyerOrgId: 'org-a', status: 'CANCELLED' }),
      ],
      partners,
    );
    expect(rows[0].cancellationRate).toBeCloseTo(0.5, 3);
  });
});

describe('Revenue advisory', () => {
  const competitive = {
    medianPeerRate: 200000,
    ourAverageRate: 200000,
    deltaPct: 0,
    sampleSize: 50,
    basis: 'test',
  };

  it('refuses a demand-based recommendation on a thin sample and says why', () => {
    const metrics = computeMetrics({ ...baseArgs, bookings: [booking()] });
    const a = advise({ metrics, competitive, partners: [], cells: [], now, dataIssues: [] });

    const gate = a.findings.find((f) => f.code === 'INSUFFICIENT_DEMAND_DATA');
    expect(gate).toBeDefined();
    expect(gate!.detail).toMatch(/will not recommend a rate move/);
    expect(a.findings.find((f) => f.code === 'REVPAR_DECOMPOSITION')).toBeUndefined();
  });

  it('puts data problems ahead of any commercial advice', () => {
    const metrics = computeMetrics({
      ...baseArgs,
      bookings: Array.from({ length: 40 }, () => booking()),
    });
    const a = advise({
      metrics,
      competitive,
      partners: [],
      cells: [],
      now,
      dataIssues: ['SITEMINDER: last event 30h ago.'],
    });
    expect(a.findings[0].code).toBe('DATA_QUALITY');
    expect(a.headline).toMatch(/Nothing commercial is worth deciding/);
  });

  it('identifies rate as the constraint when the hotel is nearly full', () => {
    const metrics = computeMetrics({
      ...baseArgs,
      roomInventory: [{ roomTypeId: 'r1', quantity: 4 }],
      bookings: Array.from({ length: 16 }, () => booking()),
    });
    const a = advise({ metrics, competitive, partners: [], cells: [], now, dataIssues: [] });
    const d = a.findings.find((f) => f.code === 'REVPAR_DECOMPOSITION')!;
    expect(d.detail).toMatch(/constraint is rate, not volume/);
  });

  it('identifies volume as the constraint when the hotel is empty', () => {
    const metrics = computeMetrics({
      ...baseArgs,
      roomInventory: [{ roomTypeId: 'r1', quantity: 200 }],
      bookings: Array.from({ length: 15 }, () => booking()),
    });
    const a = advise({ metrics, competitive, partners: [], cells: [], now, dataIssues: [] });
    const d = a.findings.find((f) => f.code === 'REVPAR_DECOMPOSITION')!;
    expect(d.detail).toMatch(/constraint is volume/);
  });

  it('recommends a targeted promotion, not a blanket cut, when priced above market', () => {
    const metrics = computeMetrics({
      ...baseArgs,
      roomInventory: [{ roomTypeId: 'r1', quantity: 100 }],
      bookings: Array.from({ length: 15 }, () => booking()),
    });
    const a = advise({
      metrics,
      competitive: { ...competitive, medianPeerRate: 150000, ourAverageRate: 200000, deltaPct: 33 },
      partners: [],
      cells: [],
      now,
      dataIssues: [],
    });
    const f = a.findings.find((f) => f.code === 'PRICED_ABOVE_MARKET')!;
    expect(f.lever).toBe('PROMOTION');
    expect(f.detail).toMatch(/without moving your public BAR/);
  });

  it('offers a ready-to-approve command for closed-to-arrival dates', () => {
    const metrics = computeMetrics({ ...baseArgs, bookings: [] });
    const a = advise({
      metrics,
      competitive,
      partners: [],
      cells: [
        cell({ stayDate: '2026-09-05', closedToArrival: true }),
        cell({ stayDate: '2026-09-06', closedToArrival: true }),
      ],
      now,
      dataIssues: [],
    });
    const f = a.findings.find((f) => f.code === 'CTA_BLOCKING')!;
    expect(f.suggestedCommand).toMatchObject({
      kind: 'update_restriction',
      restriction: { closedToArrival: false },
    });
  });

  it('flags stale inventory before drawing conclusions from its prices', () => {
    const metrics = computeMetrics({ ...baseArgs, bookings: [] });
    const a = advise({
      metrics,
      competitive,
      partners: [],
      cells: [cell({ stale: true }), cell({ stayDate: '2026-09-06' })],
      now,
      dataIssues: [],
    });
    expect(a.findings.find((f) => f.code === 'STALE_INVENTORY')).toBeDefined();
  });
});
