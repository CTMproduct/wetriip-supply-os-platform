import { DistributionPolicyRef } from '@wetriip/contracts';
import { evaluateCredit, evaluateDistribution } from './distribution';

const now = new Date('2026-09-01T12:00:00Z');

function policy(over: Partial<DistributionPolicyRef> = {}): DistributionPolicyRef {
  return {
    id: 'dp1',
    propertyId: 'p1',
    mode: 'MARKETPLACE_OPEN',
    allowedMarkets: [],
    blockedMarkets: [],
    allowedPartnerIds: [],
    blockedPartnerIds: [],
    allowedPartnerTypes: [],
    allowedChannels: [],
    minAdvanceDays: null,
    maxAdvanceDays: null,
    minLos: null,
    floorRate: null,
    floorCurrency: null,
    requiresApproval: false,
    note: null,
    version: 1,
    updatedBy: null,
    updatedAt: now.toISOString(),
    ...over,
  };
}

const request = {
  organizationId: 'org-mx',
  organizationType: 'WHOLESALER',
  market: 'MX',
  channel: 'B2B',
  checkIn: '2026-10-01',
  nights: 3,
  now,
};

describe('Distribution eligibility', () => {
  it('defaults to open when the hotel has set no policy, and says so', () => {
    const d = evaluateDistribution(null, request);
    expect(d.allowed).toBe(true);
    expect(d.checks[0].detail).toMatch(/Set a policy/);
  });

  it('closes distribution entirely', () => {
    const d = evaluateDistribution(policy({ mode: 'CLOSED' }), request);
    expect(d.allowed).toBe(false);
    expect(d.deniedBy).toContain('MODE');
  });

  it('restricts to selected partners and names the rule', () => {
    const d = evaluateDistribution(
      policy({ mode: 'SELECTED_PARTNERS', allowedPartnerIds: ['org-other'] }),
      request,
    );
    expect(d.allowed).toBe(false);
    expect(d.deniedBy).toContain('PARTNER_ALLOWED');
    expect(d.reason).toMatch(/selected partner/);
  });

  it('admits a partner that is on the allow list', () => {
    const d = evaluateDistribution(
      policy({ mode: 'SELECTED_PARTNERS', allowedPartnerIds: ['org-mx'] }),
      request,
    );
    expect(d.allowed).toBe(true);
  });

  it('lets a blocklist beat an allow list', () => {
    // A hotel that explicitly blocked a partner must not be overridden by any
    // other rule letting them back in.
    const d = evaluateDistribution(
      policy({
        mode: 'SELECTED_PARTNERS',
        allowedPartnerIds: ['org-mx'],
        blockedPartnerIds: ['org-mx'],
      }),
      request,
    );
    expect(d.allowed).toBe(false);
    expect(d.deniedBy).toContain('PARTNER_BLOCKED');
  });

  it('enforces geo restrictions on the buyer market', () => {
    expect(evaluateDistribution(policy({ blockedMarkets: ['MX'] }), request).allowed).toBe(false);
    expect(evaluateDistribution(policy({ allowedMarkets: ['US', 'GB'] }), request).allowed).toBe(false);
    expect(evaluateDistribution(policy({ allowedMarkets: ['MX'] }), request).allowed).toBe(true);
  });

  it('enforces partner type', () => {
    const d = evaluateDistribution(policy({ allowedPartnerTypes: ['AGENCY'] }), request);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/WHOLESALER/);
  });

  it('enforces the distribution booking window', () => {
    const tooLate = evaluateDistribution(policy({ minAdvanceDays: 60 }), request);
    expect(tooLate.allowed).toBe(false);
    expect(tooLate.reason).toMatch(/60 days advance/);

    expect(evaluateDistribution(policy({ minAdvanceDays: 10 }), request).allowed).toBe(true);
  });

  it('enforces the hotel rate floor over any contract', () => {
    const below = evaluateDistribution(policy({ floorRate: 500000, floorCurrency: 'COP' }), {
      ...request,
      netRate: 400000,
      netRateCurrency: 'COP',
    });
    expect(below.allowed).toBe(false);
    expect(below.deniedBy).toContain('FLOOR_RATE');
  });

  it('does not enforce a floor it cannot compare, and says why', () => {
    const d = evaluateDistribution(policy({ floorRate: 500000, floorCurrency: 'COP' }), {
      ...request,
      netRate: 120,
      netRateCurrency: 'USD',
    });
    expect(d.allowed).toBe(true);
    expect(d.checks.find((c) => c.code === 'FLOOR_RATE')?.detail).toMatch(/Not comparable/);
  });

  it('reports every failing rule, not just the first', () => {
    const d = evaluateDistribution(
      policy({ blockedMarkets: ['MX'], allowedPartnerTypes: ['AGENCY'], minLos: 5 }),
      request,
    );
    expect(d.deniedBy).toEqual(
      expect.arrayContaining(['MARKET_BLOCKED', 'PARTNER_TYPE', 'MIN_LOS']),
    );
  });
});

describe('Credit', () => {
  const base = {
    status: 'ACTIVE',
    paymentTerms: 'NET_30',
    limit: 10000,
    used: 2000,
    requested: 1000,
    currency: 'USD',
    warningPct: 80,
  };

  it('allows a booking inside the line', () => {
    const d = evaluateCredit(base);
    expect(d.allowed).toBe(true);
    expect(d.available).toBe(8000);
    expect(d.warning).toBeNull();
  });

  it('refuses a booking beyond the line and shows the numbers', () => {
    const d = evaluateCredit({ ...base, requested: 9000 });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/exceeds the 8000 USD available/);
  });

  it('warns before the hard limit rather than surprising anyone at 100%', () => {
    const d = evaluateCredit({ ...base, used: 7000, requested: 1500 });
    expect(d.allowed).toBe(true);
    expect(d.warning).toMatch(/85%/);
  });

  it('treats a prepay partner as having no credit exposure', () => {
    const d = evaluateCredit({ ...base, paymentTerms: 'PREPAY', limit: 0, requested: 999999 });
    expect(d.allowed).toBe(true);
    expect(d.requiresPrepay).toBe(true);
  });

  it('blocks suspended, pending and on-hold partners for different reasons', () => {
    expect(evaluateCredit({ ...base, status: 'SUSPENDED' }).reason).toMatch(/suspended/);
    expect(evaluateCredit({ ...base, status: 'PENDING' }).reason).toMatch(/onboarding/);
    expect(evaluateCredit({ ...base, status: 'ON_HOLD' }).reason).toMatch(/on hold/);
  });
});
