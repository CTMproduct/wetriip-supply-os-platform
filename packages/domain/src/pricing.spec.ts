import { ContractRef, PromotionRef, TaxRuleRef } from '@wetriip/contracts';
import { StaticFxProvider, buildMoneyTrace, roundForCurrency } from './fx';
import { buildPriceBreakdown } from './pricing';
import { PromotionContext, applyPromotions } from './promotions';

const fx = new StaticFxProvider();
const at = new Date('2026-08-11T12:00:00Z');

const stayDates = ['2026-09-10', '2026-09-11', '2026-09-12'];
const perNight = [600000, 600000, 600000];

const baseCtx: PromotionContext = {
  now: at,
  bookingDate: '2026-08-11',
  checkIn: '2026-09-10',
  checkOut: '2026-09-13',
  nights: 3,
  stayDates,
  adults: 2,
  children: 0,
  roomTypeCode: 'DLX',
  ratePlanCode: 'BAR',
  propertyId: 'p1',
  buyer: { organizationId: 'o-mx', market: 'MX', channel: 'B2B' },
  perNight,
};

function promo(overrides: Partial<PromotionRef> = {}, defOverrides: any = {}): PromotionRef {
  return {
    id: 'promo1',
    tenantId: 't1',
    propertyId: 'p1',
    code: 'EB30',
    name: 'Early Booking 30D',
    type: 'EARLY_BOOKING',
    status: 'ACTIVE',
    version: 1,
    priority: 100,
    stackable: false,
    validFrom: '2026-01-01',
    validTo: '2026-12-31',
    definition: {
      type: 'EARLY_BOOKING',
      scope: { propertyId: 'p1' },
      audience: { markets: ['MX'], channels: ['B2B'] },
      bookingWindow: { minAdvanceDays: 30 },
      stayWindow: { from: '2026-09-01', to: '2026-09-30' },
      los: {},
      occupancy: {},
      discount: { type: 'PERCENTAGE', value: 10 },
      stacking: { allowed: false, priority: 100 },
      ...defOverrides,
    } as any,
    ...overrides,
  };
}

describe('Currency engine', () => {
  it('preserves supplier, normalized and buyer amounts', () => {
    const trace = buildMoneyTrace({
      supplierCurrency: 'COP',
      supplierAmount: 650000,
      normalizationCurrency: 'USD',
      buyerCurrency: 'MXN',
      fx,
      at,
    });
    expect(trace.supplierAmount).toBe(650000);
    expect(trace.normalizedAmount).toBeCloseTo(163.27, 1);
    expect(trace.buyerAmount).toBeCloseTo(3051.6, 0);
    expect(trace.fx.source).toBe('static-dev-table');
  });

  it('rounds zero-decimal currencies to whole units', () => {
    expect(roundForCurrency(1234.56, 'COP')).toBe(1235);
    expect(roundForCurrency(1234.56, 'USD')).toBe(1234.56);
  });
});

describe('Promotion engine', () => {
  it('applies an eligible early-booking promotion', () => {
    const { totalDiscount, evaluations } = applyPromotions([promo()], baseCtx);
    expect(totalDiscount).toBe(180000);
    expect(evaluations[0].applied).toBe(true);
  });

  it('explains every reason an ineligible promotion did not fire', () => {
    const { evaluations, totalDiscount } = applyPromotions(
      [promo({}, { audience: { markets: ['CO'] } })],
      baseCtx,
    );
    expect(totalDiscount).toBe(0);
    expect(evaluations[0].eligible).toBe(false);
    expect(evaluations[0].reasons.join(' ')).toMatch(/market MX not targeted/);
  });

  it('discounts only the nights inside the stay window', () => {
    const { totalDiscount } = applyPromotions(
      [promo({}, { stayWindow: { from: '2026-09-10', to: '2026-09-11' } })],
      baseCtx,
    );
    // Two of three nights match: 10% of 1,200,000.
    expect(totalDiscount).toBe(120000);
  });

  it('does not stack a non-stackable promotion with anything else', () => {
    const a = promo({ id: 'a', code: 'A', priority: 10, stackable: false });
    const b = promo({ id: 'b', code: 'B', priority: 20, stackable: true });
    const { evaluations, totalDiscount } = applyPromotions([a, b], baseCtx);
    expect(totalDiscount).toBe(180000);
    expect(evaluations.find((e) => e.code === 'B')?.applied).toBe(false);
    expect(evaluations.find((e) => e.code === 'B')?.reasons.join(' ')).toMatch(/non-stackable/);
  });

  it('refuses a booking that is not far enough ahead', () => {
    const { evaluations } = applyPromotions([promo()], {
      ...baseCtx,
      bookingDate: '2026-09-05',
    });
    expect(evaluations[0].reasons.join(' ')).toMatch(/needs 30d advance/);
  });
});

describe('Pricing pipeline', () => {
  const taxes: TaxRuleRef[] = [
    {
      id: 'tx1',
      propertyId: 'p1',
      code: 'IVA',
      name: 'IVA 19%',
      mode: 'PERCENTAGE',
      value: 19,
      currency: null,
      included: false,
    },
  ];

  const contract: ContractRef = {
    id: 'c1',
    tenantId: 't1',
    code: 'CTR',
    name: 'Test',
    supplierOrgId: 's',
    buyerOrgId: 'b',
    status: 'PUBLISHED',
    version: 1,
    validFrom: '2026-01-01',
    validTo: '2026-12-31',
    currency: 'COP',
    paymentModel: 'COMMISSION',
    commissionPct: 12,
    markupPct: 0,
    markets: ['MX'],
    channels: ['B2B'],
    propertyIds: [],
    cancellationPolicy: null,
    maxResaleDepth: 2,
  };

  it('applies steps in the fixed order and records every one', () => {
    const price = buildPriceBreakdown({
      stayDates,
      perNightBase: perNight,
      supplierCurrency: 'COP',
      buyerCurrency: 'MXN',
      normalizationCurrency: 'USD',
      adults: 2,
      children: 0,
      promotions: [promo()],
      promotionContext: baseCtx,
      contract,
      taxes,
      fx,
      at,
    });

    const steps = price.steps.map((s) => s.step);
    expect(steps).toEqual([
      'BASE',
      'PROMOTION',
      'CONTRACT_COMMISSION',
      'TAX',
      'FX',
      'ROUNDING',
    ]);

    // 1,800,000 base - 180,000 promo = 1,620,000 net; +19% IVA = 1,927,800.
    expect(price.netAmount).toBe(1620000);
    expect(price.taxAmount).toBe(307800);
    expect(price.grossAmount).toBe(1927800);
    // Commission is settled, not added to what the buyer pays.
    expect(price.commissionAmount).toBe(194400);
    expect(price.money.supplierAmount).toBe(1927800);
  });

  it('does not add commission to the buyer total', () => {
    const withCommission = buildPriceBreakdown({
      stayDates,
      perNightBase: perNight,
      supplierCurrency: 'COP',
      buyerCurrency: 'COP',
      normalizationCurrency: 'USD',
      adults: 2,
      children: 0,
      promotions: [],
      promotionContext: baseCtx,
      contract,
      taxes: [],
      fx,
      at,
    });
    expect(withCommission.grossAmount).toBe(1800000);
    expect(withCommission.commissionAmount).toBe(216000);
  });

  it('adds a contract markup to what the buyer pays', () => {
    const price = buildPriceBreakdown({
      stayDates,
      perNightBase: perNight,
      supplierCurrency: 'COP',
      buyerCurrency: 'COP',
      normalizationCurrency: 'USD',
      adults: 2,
      children: 0,
      promotions: [],
      promotionContext: baseCtx,
      contract: { ...contract, paymentModel: 'NET', commissionPct: 0, markupPct: 8 },
      taxes: [],
      fx,
      at,
    });
    expect(price.grossAmount).toBe(1944000);
    expect(price.steps.find((s) => s.step === 'CONTRACT_MARKUP')?.delta).toBe(144000);
  });
});
