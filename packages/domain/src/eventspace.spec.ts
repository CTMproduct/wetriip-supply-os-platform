import { EventQuoteRequest } from '@wetriip/contracts';
import { EventSpaceSpec, addonCatalog, assertLayoutFits, quoteEventSpace } from './eventspace';

const salon: EventSpaceSpec = {
  id: 's1',
  name: 'Salón Bahía',
  currency: 'COP',
  halfDayHours: 4,
  fullDayHours: 8,
  layouts: [
    { layout: 'THEATRE', capacity: 120, setupFee: 0 },
    { layout: 'U_SHAPE', capacity: 28, setupFee: 150000 },
    { layout: 'BANQUET', capacity: 80, setupFee: 300000 },
  ],
  rates: [
    { unit: 'HOUR', amount: 250000, minimumPax: 0 },
    { unit: 'HALF_DAY', amount: 800000, minimumPax: 0 },
    { unit: 'FULL_DAY', amount: 1400000, minimumPax: 0 },
  ],
  addons: [
    { kind: 'VIDEOBEAM', name: 'Videobeam', unit: 'PER_DAY', amount: 180000, includedInSpace: false, description: null },
    { kind: 'MICROPHONE', name: 'Micrófono', unit: 'PER_EVENT', amount: 0, includedInSpace: true, description: null },
    { kind: 'WIRELESS_MICROPHONE', name: 'Micrófono inalámbrico', unit: 'PER_EVENT', amount: 90000, includedInSpace: false, description: null },
    { kind: 'COFFEE_BREAK', name: 'Coffee break', unit: 'PER_PERSON', amount: 22000, includedInSpace: false, description: null },
    { kind: 'LUNCH', name: 'Almuerzo', unit: 'PER_PERSON', amount: 65000, includedInSpace: false, description: null },
  ],
};

const req = (over: Partial<EventQuoteRequest> = {}): EventQuoteRequest => ({
  spaceId: 's1',
  date: '2026-09-10',
  layout: 'THEATRE',
  pax: 60,
  hours: null,
  days: 1,
  addons: [],
  ...over,
});

describe('layout capacity', () => {
  it('accepts a group that fits the chosen layout', () => {
    expect(assertLayoutFits(salon, 'THEATRE', 100).capacity).toBe(120);
  });

  it('refuses a layout the room is not set up in, and lists the ones it is', () => {
    expect(() => assertLayoutFits(salon, 'CLASSROOM', 20)).toThrow(/not set up in Escuela/i);
    try {
      assertLayoutFits(salon, 'CLASSROOM', 20);
    } catch (e: any) {
      expect(e.remediation).toMatch(/Auditorio \(120\)/);
    }
  });

  it('refuses 80 people in a U and suggests the layout that would hold them', () => {
    try {
      assertLayoutFits(salon, 'U_SHAPE', 80);
      throw new Error('should have refused');
    } catch (e: any) {
      expect(e.message).toMatch(/seats 28 in En U, not 80/);
      expect(e.remediation).toMatch(/Banquete would take 80/);
    }
  });
});

describe('quoting the space', () => {
  it('charges the cheapest applicable unit and says what else it considered', () => {
    const q = quoteEventSpace({ space: salon, request: req({ hours: 4 }) });
    // 4 h by the hour is 1,000,000; the half day is 800,000.
    expect(q.lines[0].unit).toBe('HALF_DAY');
    expect(q.spaceTotal).toBe(800000);
    expect(q.warnings.join(' ')).toMatch(/HOUR 1,000,000/);
  });

  it('falls back to the full day when no hours are given', () => {
    const q = quoteEventSpace({ space: salon, request: req() });
    expect(q.hours).toBe(8);
    expect(q.lines[0].unit).toBe('FULL_DAY');
  });

  it('does not offer a half-day rate for more hours than a half day', () => {
    const q = quoteEventSpace({ space: salon, request: req({ hours: 6 }) });
    expect(q.lines[0].unit).toBe('FULL_DAY');
    expect(q.warnings.join(' ')).not.toMatch(/HALF_DAY/);
  });

  it('adds the setup fee only for layouts that carry one', () => {
    const withFee = quoteEventSpace({ space: salon, request: req({ layout: 'U_SHAPE', pax: 20 }) });
    expect(withFee.lines.some((l) => l.step === 'SETUP')).toBe(true);
    const without = quoteEventSpace({ space: salon, request: req() });
    expect(without.lines.some((l) => l.step === 'SETUP')).toBe(false);
  });

  it('defaults a per-person addon to the whole room', () => {
    const q = quoteEventSpace({
      space: salon,
      request: req({ pax: 60, addons: [{ kind: 'COFFEE_BREAK', quantity: 1 }] }),
    });
    const coffee = q.lines.find((l) => l.label === 'Coffee break')!;
    expect(coffee.quantity).toBe(60);
    expect(coffee.amount).toBe(1320000);
    expect(coffee.step).toBe('CATERING');
  });

  it('separates catering from equipment, because they are different decisions', () => {
    const q = quoteEventSpace({
      space: salon,
      request: req({
        pax: 40,
        addons: [
          { kind: 'VIDEOBEAM', quantity: 1 },
          { kind: 'LUNCH', quantity: 1 },
        ],
      }),
    });
    expect(q.equipmentTotal).toBe(180000);
    expect(q.cateringTotal).toBe(2600000);
  });

  it('lists an included item at zero rather than hiding it', () => {
    const q = quoteEventSpace({
      space: salon,
      request: req({ addons: [{ kind: 'MICROPHONE', quantity: 1 }] }),
    });
    const mic = q.lines.find((l) => l.label === 'Micrófono')!;
    expect(mic.amount).toBe(0);
    expect(mic.explanation).toBe('Incluido con el salón');
  });

  it('warns instead of silently dropping an addon the space does not offer', () => {
    const q = quoteEventSpace({
      space: salon,
      request: req({ addons: [{ kind: 'STREAMING', quantity: 1 }] }),
    });
    expect(q.warnings.join(' ')).toMatch(/Transmisión en vivo is not offered/);
  });

  it('totals the pipeline and derives a per-person figure', () => {
    const q = quoteEventSpace({
      space: salon,
      request: req({
        pax: 50,
        hours: 8,
        days: 2,
        addons: [
          { kind: 'VIDEOBEAM', quantity: 1 },
          { kind: 'COFFEE_BREAK', quantity: 1 },
        ],
      }),
      taxPct: 19,
    });
    // space 2,800,000 + videobeam 360,000 + coffee 1,100,000 = 4,260,000
    expect(q.subtotal).toBe(4260000);
    expect(q.taxTotal).toBe(809400);
    expect(q.total).toBe(5069400);
    expect(q.perPerson).toBe(101388);
  });

  it('refuses to quote a room the group does not fit in', () => {
    expect(() => quoteEventSpace({ space: salon, request: req({ pax: 200 }) })).toThrow(/seats 120/);
  });

  it('refuses when the space has no rate that covers the request', () => {
    const noRates: EventSpaceSpec = { ...salon, rates: [{ unit: 'HALF_DAY', amount: 800000, minimumPax: 0 }] };
    expect(() => quoteEventSpace({ space: noRates, request: req({ hours: 8 }) })).toThrow(
      /no rate that covers 8 h/,
    );
  });

  it('bills a per-person rate at its minimum when the group is smaller', () => {
    const perPerson: EventSpaceSpec = {
      ...salon,
      rates: [{ unit: 'PER_PERSON', amount: 90000, minimumPax: 30 }],
    };
    const q = quoteEventSpace({ space: perPerson, request: req({ pax: 12 }) });
    expect(q.lines[0].quantity).toBe(30);
    expect(q.lines[0].explanation).toMatch(/billed at the 30 minimum/);
  });
});

describe('the addon catalog', () => {
  it('splits equipment from catering the way a hotel thinks about them', () => {
    const cat = addonCatalog(salon);
    expect(cat.equipment.map((a) => a.kind)).toEqual([
      'VIDEOBEAM',
      'MICROPHONE',
      'WIRELESS_MICROPHONE',
    ]);
    expect(cat.catering.map((a) => a.kind)).toEqual(['COFFEE_BREAK', 'LUNCH']);
  });
});
