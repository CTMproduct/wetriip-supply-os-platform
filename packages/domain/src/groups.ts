import {
  BEDDING_PAX,
  Bedding,
  GroupBenefit,
  GroupBlockLine,
  GroupRoomRequest,
  StayDate,
  nightsBetween,
} from '@wetriip/contracts';

/**
 * Group arithmetic.
 *
 * Pure, because every number here is one a hotel and an agency will argue
 * about. If a comp room or a floor rate cannot be recomputed from the inputs
 * alone, the platform has no answer when they do.
 */

/* ── Capacity ────────────────────────────────────────────── */

export interface BlockConsumption {
  /** Rooms already committed to accepted groups, per bedding. */
  committed: Partial<Record<Bedding, number>>;
  /** Rooms soft-held by live offers, per bedding. */
  held: Partial<Record<Bedding, number>>;
}

export interface BlockAvailability {
  bedding: Bedding;
  roomsTotal: number;
  committed: number;
  held: number;
  available: number;
}

export interface BlockCapacity {
  lines: BlockAvailability[];
  /** The physical cap. Lines may sum above it — the same rooms convert. */
  roomsCeiling: number;
  ceilingCommitted: number;
  ceilingHeld: number;
  ceilingAvailable: number;
}

const sum = (o: Partial<Record<Bedding, number>>) =>
  Object.values(o).reduce<number>((a, b) => a + (b ?? 0), 0);

/**
 * Two constraints, both real, and conflating them is the classic group
 * oversell: a line may not exceed its own declared maximum, AND the block may
 * not exceed the number of rooms that physically exist.
 */
export function blockCapacity(
  lines: GroupBlockLine[],
  roomsCeiling: number,
  consumption: BlockConsumption,
): BlockCapacity {
  const rows: BlockAvailability[] = lines.map((l) => {
    const committed = consumption.committed[l.bedding] ?? 0;
    const held = consumption.held[l.bedding] ?? 0;
    return {
      bedding: l.bedding,
      roomsTotal: l.roomsTotal,
      committed,
      held,
      available: Math.max(0, l.roomsTotal - committed - held),
    };
  });

  const ceilingCommitted = sum(consumption.committed);
  const ceilingHeld = sum(consumption.held);
  const ceilingAvailable = Math.max(0, roomsCeiling - ceilingCommitted - ceilingHeld);

  return { lines: rows, roomsCeiling, ceilingCommitted, ceilingHeld, ceilingAvailable };
}

export interface FitResult {
  fits: boolean;
  reasons: string[];
  roomsRequested: number;
  paxCapacity: number;
}

/**
 * Can this block take this group? Answers with every reason at once rather
 * than the first — an agency that has to resubmit three times to learn three
 * problems goes somewhere else.
 */
export function canBlockTake(
  capacity: BlockCapacity,
  requested: GroupRoomRequest[],
  pax: number,
): FitResult {
  const reasons: string[] = [];
  const roomsRequested = requested.reduce((a, r) => a + r.rooms, 0);
  let paxCapacity = 0;

  for (const req of requested) {
    const line = capacity.lines.find((l) => l.bedding === req.bedding);
    if (!line) {
      reasons.push(`The block offers no ${req.bedding} rooms.`);
      continue;
    }
    paxCapacity += req.rooms * BEDDING_PAX[req.bedding];
    if (req.rooms > line.available) {
      reasons.push(
        `${req.rooms} ${req.bedding} requested, ${line.available} available ` +
          `(${line.roomsTotal} in the block, ${line.committed} committed, ${line.held} on hold).`,
      );
    }
  }

  if (roomsRequested > capacity.ceilingAvailable) {
    reasons.push(
      `${roomsRequested} rooms requested but only ${capacity.ceilingAvailable} remain against ` +
        `the block ceiling of ${capacity.roomsCeiling}.`,
    );
  }

  if (paxCapacity > 0 && pax > paxCapacity) {
    reasons.push(
      `${pax} people do not fit in ${roomsRequested} rooms of these bedding types ` +
        `(capacity ${paxCapacity}).`,
    );
  }

  return { fits: reasons.length === 0, reasons, roomsRequested, paxCapacity };
}

/* ── Benefits ────────────────────────────────────────────── */

export interface GrantedBenefit {
  kind: string;
  units: number;
  basis: string;
  /** The arithmetic, spelled out, so nobody has to trust the number. */
  explanation: string;
  description: string | null;
}

/**
 * "One free per twenty" is the single most common group term and the single
 * most common source of an argument at check-out. Two decisions make it
 * reproducible:
 *
 *  · the comp room is NOT counted as a paying room when computing the next
 *    comp — 21 rooms earns one free, not one free and a fraction
 *  · PER_NIGHT multiplies by nights, PER_STAY does not, and the result says
 *    which it used
 */
export function computeGroupBenefits(
  benefits: GroupBenefit[],
  roomsPaid: number,
  nights: number,
): GrantedBenefit[] {
  return benefits
    .map((b) => {
      const perOccurrence = Math.floor(roomsPaid / b.everyNRooms);
      const raw = b.basis === 'PER_NIGHT' ? perOccurrence * Math.max(1, nights) : perOccurrence;
      const units = b.maxUnits == null ? raw : Math.min(raw, b.maxUnits);
      const capped = b.maxUnits != null && raw > b.maxUnits;

      return {
        kind: b.kind,
        units,
        basis: b.basis,
        description: b.description,
        explanation:
          units === 0
            ? `${roomsPaid} paid rooms is below the ${b.everyNRooms} needed to earn one.`
            : `1 per ${b.everyNRooms} paid rooms × ${roomsPaid} rooms` +
              (b.basis === 'PER_NIGHT' ? ` × ${Math.max(1, nights)} nights` : '') +
              ` = ${raw}` +
              (capped ? `, capped at ${b.maxUnits}` : ''),
      };
    })
    .filter((g) => g.units > 0 || g.kind === 'COMP_ROOM');
}

/** Money the comp rooms are worth, so a hotel sees the true cost of the term. */
export function compRoomValue(
  granted: GrantedBenefit[],
  ratePerNight: number,
  nights: number,
): number {
  const comp = granted.find((g) => g.kind === 'COMP_ROOM');
  if (!comp || comp.units === 0) return 0;
  // A PER_NIGHT grant already carries the nights inside its unit count.
  return comp.basis === 'PER_NIGHT'
    ? round2(comp.units * ratePerNight)
    : round2(comp.units * ratePerNight * Math.max(1, nights));
}

/* ── The bid ─────────────────────────────────────────────── */

export type BidVerdict = 'ABOVE_FLOOR' | 'BELOW_FLOOR' | 'NO_FLOOR_SET';

export interface BidEvaluation {
  roomNights: number;
  /** What the agency's budget works out to per room per night. */
  offeredAdr: number;
  floorRate: number | null;
  verdict: BidVerdict;
  /** Positive when the offer clears the floor. */
  gapPerRoomNight: number | null;
  /** What the hotel would need to receive for THIS group to hit its floor,
   *  counting the comp room-nights it occupies but does not bill. */
  floorTotal: number | null;
  /** How much the hotel gives up against its own floor by accepting. */
  shortfallTotal: number | null;
  benefits: GrantedBenefit[];
  compValue: number;
  /** Offered money net of what the comp rooms cost to honour. */
  netAdr: number;
  explanation: string[];
}

/**
 * Evaluate an agency's budget against the hotel's own floor.
 *
 * It returns a verdict and never a decision. A hotel accepting below its floor
 * to fill a shoulder date is a legitimate commercial choice — the engine's job
 * is to make sure nobody makes it by accident, which is why the shortfall is
 * computed in money rather than left as "below floor".
 *
 * The netAdr is the number that actually matters and the one hotels most often
 * miss: fifteen rooms at $100 with one free is not $100 a room.
 */
export function evaluateBid(args: {
  budgetTotal: number;
  rooms: GroupRoomRequest[];
  checkIn: StayDate;
  checkOut: StayDate;
  floorRatePerNight: number | null;
  benefits: GroupBenefit[];
}): BidEvaluation {
  const nights = Math.max(1, nightsBetween(args.checkIn, args.checkOut));
  const roomsPaid = args.rooms.reduce((a, r) => a + r.rooms, 0);
  const roomNights = roomsPaid * nights;

  const offeredAdr = roomNights > 0 ? round2(args.budgetTotal / roomNights) : 0;
  const benefits = computeGroupBenefits(args.benefits, roomsPaid, nights);
  const compUnits = benefits.find((b) => b.kind === 'COMP_ROOM')?.units ?? 0;
  const compBasis = benefits.find((b) => b.kind === 'COMP_ROOM')?.basis ?? 'PER_STAY';
  const compRoomNights = compBasis === 'PER_NIGHT' ? compUnits : compUnits * nights;

  // The comp rooms are room-nights the hotel occupies and does not bill, so the
  // real yield spreads the same money over more nights.
  const netAdr =
    roomNights + compRoomNights > 0 ? round2(args.budgetTotal / (roomNights + compRoomNights)) : 0;
  const compValue = round2(compRoomNights * offeredAdr);

  const floor = args.floorRatePerNight;
  const verdict: BidVerdict =
    floor == null ? 'NO_FLOOR_SET' : netAdr >= floor ? 'ABOVE_FLOOR' : 'BELOW_FLOOR';

  // Both figures come off the raw money, never off the rounded ADR. Deriving
  // the shortfall from a 2-decimal ADR loses cents per room-night and turns an
  // exact 1,000 into 999.90 — which is precisely the kind of number a hotel
  // notices and stops trusting the tool over.
  const occupiedRoomNights = roomNights + compRoomNights;
  const floorTotal = floor == null ? null : round2(floor * occupiedRoomNights);
  const gap = floor == null ? null : round2(netAdr - floor);
  const shortfall =
    floorTotal == null || args.budgetTotal >= floorTotal
      ? null
      : round2(floorTotal - args.budgetTotal);

  const explanation: string[] = [
    `${roomsPaid} rooms × ${nights} night(s) = ${roomNights} room-nights.`,
    `Budget ${fmt(args.budgetTotal)} ÷ ${roomNights} = ${fmt(offeredAdr)} per room-night.`,
  ];
  if (compRoomNights > 0) {
    explanation.push(
      `${compRoomNights} comp room-night(s) are occupied but not billed, so the real yield is ` +
        `${fmt(args.budgetTotal)} ÷ ${roomNights + compRoomNights} = ${fmt(netAdr)}.`,
    );
  }
  if (floor == null) {
    explanation.push('No group floor rate is set, so there is nothing to measure this against.');
  } else if (verdict === 'ABOVE_FLOOR') {
    explanation.push(`Floor is ${fmt(floor)}. The offer clears it by ${fmt(gap ?? 0)} per room-night.`);
  } else {
    explanation.push(
      `Floor is ${fmt(floor)}. Accepting gives up ${fmt(shortfall ?? 0)} against it ` +
        `(${fmt(Math.abs(gap ?? 0))} per room-night).`,
    );
  }

  return {
    roomNights,
    offeredAdr,
    floorRate: floor,
    verdict,
    gapPerRoomNight: gap,
    floorTotal,
    shortfallTotal: shortfall,
    benefits,
    compValue,
    netAdr,
    explanation,
  };
}

/**
 * The deadline is part of the offer, not a background job's opinion. Computing
 * it here means the expiry a hotel is shown and the expiry the sweeper enforces
 * are the same number.
 */
export function bidExpiry(createdAt: Date, responseWindowHours: number): Date {
  return new Date(createdAt.getTime() + responseWindowHours * 3_600_000);
}

export function hoursRemaining(expiresAt: Date, now: Date): number {
  return Math.max(0, (expiresAt.getTime() - now.getTime()) / 3_600_000);
}

export function isExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
