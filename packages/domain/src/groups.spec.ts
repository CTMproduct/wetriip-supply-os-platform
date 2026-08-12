import { GroupBenefit, GroupBlockLine } from '@wetriip/contracts';
import {
  bidExpiry,
  blockCapacity,
  canBlockTake,
  compRoomValue,
  computeGroupBenefits,
  evaluateBid,
  hoursRemaining,
  isExpired,
} from './groups';

const lines: GroupBlockLine[] = [
  { roomTypeId: 'r1', bedding: 'TWIN', roomsTotal: 18, ratePerNight: 400000 },
  { roomTypeId: 'r1', bedding: 'DOUBLE', roomsTotal: 20, ratePerNight: 400000 },
];

const comp: GroupBenefit = {
  kind: 'COMP_ROOM',
  everyNRooms: 20,
  maxUnits: null,
  basis: 'PER_STAY',
  description: null,
};

describe('block capacity', () => {
  it('lets bedding lines sum above the ceiling, because the same rooms convert', () => {
    const cap = blockCapacity(lines, 20, { committed: {}, held: {} });
    expect(cap.lines.find((l) => l.bedding === 'TWIN')!.available).toBe(18);
    expect(cap.lines.find((l) => l.bedding === 'DOUBLE')!.available).toBe(20);
    // …but only 20 rooms exist.
    expect(cap.ceilingAvailable).toBe(20);
  });

  it('counts held rooms against both the line and the ceiling', () => {
    const cap = blockCapacity(lines, 20, { committed: { TWIN: 4 }, held: { DOUBLE: 6 } });
    expect(cap.lines.find((l) => l.bedding === 'TWIN')!.available).toBe(14);
    expect(cap.lines.find((l) => l.bedding === 'DOUBLE')!.available).toBe(14);
    expect(cap.ceilingAvailable).toBe(10);
  });

  it('never reports negative availability', () => {
    const cap = blockCapacity(lines, 20, { committed: { TWIN: 30 }, held: {} });
    expect(cap.lines.find((l) => l.bedding === 'TWIN')!.available).toBe(0);
    expect(cap.ceilingAvailable).toBe(0);
  });
});

describe('fitting a group into a block', () => {
  it('accepts a group that fits both constraints', () => {
    const cap = blockCapacity(lines, 20, { committed: {}, held: {} });
    const fit = canBlockTake(cap, [{ bedding: 'TWIN', rooms: 5 }], 10);
    expect(fit.fits).toBe(true);
    expect(fit.reasons).toEqual([]);
  });

  it('refuses on the ceiling even when every line individually has room', () => {
    const cap = blockCapacity(lines, 20, { committed: {}, held: {} });
    const fit = canBlockTake(
      cap,
      [
        { bedding: 'TWIN', rooms: 15 },
        { bedding: 'DOUBLE', rooms: 15 },
      ],
      60,
    );
    expect(fit.fits).toBe(false);
    expect(fit.reasons.join(' ')).toMatch(/block ceiling of 20/);
  });

  it('refuses a bedding the block does not offer, by name', () => {
    const cap = blockCapacity(lines, 20, { committed: {}, held: {} });
    const fit = canBlockTake(cap, [{ bedding: 'TRIPLE', rooms: 2 }], 6);
    expect(fit.fits).toBe(false);
    expect(fit.reasons[0]).toMatch(/no TRIPLE/);
  });

  it('refuses when the people do not fit in the rooms asked for', () => {
    const cap = blockCapacity(lines, 20, { committed: {}, held: {} });
    const fit = canBlockTake(cap, [{ bedding: 'DOUBLE', rooms: 3 }], 10);
    expect(fit.fits).toBe(false);
    expect(fit.reasons.join(' ')).toMatch(/10 people do not fit/);
  });

  it('reports every problem at once rather than the first', () => {
    const cap = blockCapacity(lines, 20, { committed: { TWIN: 16 }, held: {} });
    const fit = canBlockTake(cap, [{ bedding: 'TWIN', rooms: 10 }], 40);
    expect(fit.reasons.length).toBeGreaterThan(1);
  });
});

describe('group benefits', () => {
  it('grants one free room per twenty paid', () => {
    const [g] = computeGroupBenefits([comp], 40, 3);
    expect(g.units).toBe(2);
    expect(g.explanation).toMatch(/1 per 20 paid rooms × 40 rooms = 2/);
  });

  it('does not round a partial entitlement up', () => {
    const [g] = computeGroupBenefits([comp], 39, 3);
    expect(g.units).toBe(1);
  });

  it('reports zero with the reason rather than omitting the benefit', () => {
    const [g] = computeGroupBenefits([comp], 12, 2);
    expect(g.units).toBe(0);
    expect(g.explanation).toMatch(/below the 20 needed/);
  });

  it('multiplies by nights only on a PER_NIGHT basis', () => {
    const perNight = computeGroupBenefits([{ ...comp, basis: 'PER_NIGHT' }], 40, 3);
    expect(perNight[0].units).toBe(6);
    const perStay = computeGroupBenefits([comp], 40, 3);
    expect(perStay[0].units).toBe(2);
  });

  it('honours the cap and says it capped', () => {
    const [g] = computeGroupBenefits([{ ...comp, maxUnits: 1 }], 100, 1);
    expect(g.units).toBe(1);
    expect(g.explanation).toMatch(/capped at 1/);
  });

  it('prices the comp rooms so the hotel sees what the term costs', () => {
    const granted = computeGroupBenefits([comp], 40, 3);
    expect(compRoomValue(granted, 400000, 3)).toBe(2400000);
  });
});

describe('evaluating an agency bid', () => {
  const base = {
    rooms: [{ bedding: 'DOUBLE' as const, rooms: 10 }],
    checkIn: '2026-09-10',
    checkOut: '2026-09-13',
    floorRatePerNight: 300,
    benefits: [] as GroupBenefit[],
  };

  it('turns a budget into an ADR', () => {
    const e = evaluateBid({ ...base, budgetTotal: 9000 });
    expect(e.roomNights).toBe(30);
    expect(e.offeredAdr).toBe(300);
    expect(e.verdict).toBe('ABOVE_FLOOR');
  });

  it('names the shortfall in money, not just "below floor"', () => {
    const e = evaluateBid({ ...base, budgetTotal: 8000 });
    expect(e.verdict).toBe('BELOW_FLOOR');
    expect(e.offeredAdr).toBeCloseTo(266.67, 2);
    expect(e.shortfallTotal).toBe(1000);
    expect(e.explanation.join(' ')).toMatch(/gives up/);
  });

  it('spreads the money over comp room-nights, which is the number hotels miss', () => {
    const withComp = evaluateBid({
      ...base,
      rooms: [{ bedding: 'DOUBLE', rooms: 20 }],
      budgetTotal: 18000,
      benefits: [comp],
    });
    // 20 rooms × 3 nights = 60 billed room-nights → 300 apparent ADR…
    expect(withComp.offeredAdr).toBe(300);
    // …but one comp room for the stay adds 3 unbilled room-nights.
    expect(withComp.netAdr).toBeCloseTo(285.71, 2);
    expect(withComp.verdict).toBe('BELOW_FLOOR');
  });

  it('states plainly when no floor has been set instead of inventing one', () => {
    const e = evaluateBid({ ...base, budgetTotal: 1, floorRatePerNight: null });
    expect(e.verdict).toBe('NO_FLOOR_SET');
    expect(e.shortfallTotal).toBeNull();
    expect(e.explanation.join(' ')).toMatch(/No group floor rate is set/);
  });

  it('treats a same-day request as one night rather than dividing by zero', () => {
    const e = evaluateBid({ ...base, checkOut: '2026-09-10', budgetTotal: 3000 });
    expect(e.roomNights).toBe(10);
    expect(Number.isFinite(e.offeredAdr)).toBe(true);
  });
});

describe('the 24-hour clock', () => {
  const created = new Date('2026-09-01T10:00:00.000Z');

  it('computes the deadline from the window the hotel set', () => {
    expect(bidExpiry(created, 24).toISOString()).toBe('2026-09-02T10:00:00.000Z');
    expect(bidExpiry(created, 48).toISOString()).toBe('2026-09-03T10:00:00.000Z');
  });

  it('counts down and never goes negative', () => {
    const exp = bidExpiry(created, 24);
    expect(hoursRemaining(exp, new Date('2026-09-01T22:00:00.000Z'))).toBe(12);
    expect(hoursRemaining(exp, new Date('2026-09-05T00:00:00.000Z'))).toBe(0);
  });

  it('expires exactly at the deadline, not a millisecond after', () => {
    const exp = bidExpiry(created, 24);
    expect(isExpired(exp, new Date('2026-09-02T09:59:59.999Z'))).toBe(false);
    expect(isExpired(exp, exp)).toBe(true);
  });
});
