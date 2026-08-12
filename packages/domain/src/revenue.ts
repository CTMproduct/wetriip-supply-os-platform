import {
  AdvisoryFinding,
  CompetitivePosition,
  Confidence,
  EffectiveAriRow,
  MetricWindow,
  PartnerProduction,
  RevenueAdvisory,
  RevenueMetrics,
  StayDate,
  StructuredCommand,
} from '@wetriip/contracts';
import Decimal from 'decimal.js';

/**
 * Revenue management engine.
 *
 * Two jobs, kept separate on purpose:
 *
 *   computeMetrics()  — arithmetic. No opinions.
 *   advise()          — opinions, each one derived from those numbers and
 *                       carrying them in its own text.
 *
 * The discipline that makes this useful rather than decorative is the
 * confidence gate. A revenue recommendation built on four bookings is worse
 * than no recommendation, because someone will act on it. Below the threshold
 * the engine describes the inventory and the pricing position — which are
 * observable — and explicitly declines to make a demand-based call.
 *
 * The LLM narrates these findings. It does not compute them, and it is told in
 * its system prompt not to invent numbers that are not here.
 */

const MIN_BOOKINGS_FOR_DEMAND = 12;
const MIN_BOOKINGS_MEDIUM = 30;
const MIN_BOOKINGS_HIGH = 80;

const DOW_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface BookingFact {
  id: string;
  buyerOrgId: string;
  checkIn: StayDate;
  checkOut: StayDate;
  nights: number;
  /** ALWAYS in the property currency. The caller converts before it gets here,
   *  because an ADR that averages MXN and COP is a number that means nothing. */
  amount: number;
  currencyCode: string;
  /** True when `amount` came from an FX conversion rather than the supplier. */
  converted?: boolean;
  status: string;
  createdAt: Date;
}

export interface OfferFact {
  propertyId: string;
  roomTypeId: string;
  ratePlanId: string;
  checkIn: StayDate;
  nights: number;
  supplierAmount: number;
  createdAt: Date;
}

export interface PartnerFact {
  organizationId: string;
  name: string;
  type: string;
  country: string;
  contractCode: string | null;
  commissionPct: number | null;
  markupPct: number | null;
}

export interface ComputeMetricsArgs {
  propertyId: string;
  propertyName: string;
  currency: string;
  window: { from: StayDate; to: StayDate };
  /** Physical rooms, by room type id. Capacity, not availability. */
  roomInventory: Array<{ roomTypeId: string; quantity: number }>;
  cells: EffectiveAriRow[];
  bookings: BookingFact[];
  offers: OfferFact[];
  searches: number;
  now: Date;
  fxSource?: string | null;
}

function nightsBetween(a: StayDate, b: StayDate): number {
  return Math.round(
    (new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000,
  );
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 100) / 100;
}

function grade(bookings: number): Confidence {
  if (bookings === 0) return 'NONE';
  if (bookings < MIN_BOOKINGS_FOR_DEMAND) return 'LOW';
  if (bookings < MIN_BOOKINGS_MEDIUM) return 'MEDIUM';
  return bookings < MIN_BOOKINGS_HIGH ? 'MEDIUM' : 'HIGH';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeMetrics(args: ComputeMetricsArgs): RevenueMetrics {
  const windowNights = Math.max(1, nightsBetween(args.window.from, args.window.to));
  const window: MetricWindow = { from: args.window.from, to: args.window.to, nights: windowNights };

  // Capacity is physical rooms x nights, NOT what the channel manager happened
  // to leave open. Using open inventory as the denominator flatters occupancy
  // exactly when a hotel is closing itself out by mistake — the case we most
  // need to see.
  const totalRooms = args.roomInventory.reduce((s, r) => s + r.quantity, 0);
  const roomNightsAvailable = totalRooms * windowNights;

  const sold = args.bookings.filter((b) => b.status === 'CONFIRMED');
  const roomNightsSold = sold.reduce((s, b) => s + b.nights, 0);
  const roomRevenue = round2(sold.reduce((s, b) => s + b.amount, 0));

  const occupancy =
    roomNightsAvailable > 0 ? round2((roomNightsSold / roomNightsAvailable) * 100) / 100 : null;
  const adr = roomNightsSold > 0 ? round2(roomRevenue / roomNightsSold) : null;
  // Computed from revenue and capacity directly, not by multiplying two
  // already-rounded numbers.
  const revpar = roomNightsAvailable > 0 ? round2(roomRevenue / roomNightsAvailable) : null;

  const offeredRates = args.offers.map((o) => (o.nights > 0 ? o.supplierAmount / o.nights : 0)).filter((n) => n > 0);
  const cellRates = args.cells
    .filter((c) => c.baseAmount != null && c.open)
    .map((c) => c.baseAmount as number);
  const rateSample = offeredRates.length >= 5 ? offeredRates : cellRates;

  const leadTimeBuckets = [
    { label: '0-3 days', minDays: 0, maxDays: 3, bookings: 0 },
    { label: '4-7 days', minDays: 4, maxDays: 7, bookings: 0 },
    { label: '8-21 days', minDays: 8, maxDays: 21, bookings: 0 },
    { label: '22-45 days', minDays: 22, maxDays: 45, bookings: 0 },
    { label: '46+ days', minDays: 46, maxDays: null as number | null, bookings: 0 },
  ];
  for (const b of sold) {
    const lead = Math.max(
      0,
      Math.round(
        (new Date(`${b.checkIn}T00:00:00Z`).getTime() - b.createdAt.getTime()) / 86_400_000,
      ),
    );
    const bucket =
      leadTimeBuckets.find((x) => lead >= x.minDays && (x.maxDays == null || lead <= x.maxDays)) ??
      leadTimeBuckets[leadTimeBuckets.length - 1];
    bucket.bookings += 1;
  }

  const losMap = new Map<number, number>();
  for (const b of sold) losMap.set(b.nights, (losMap.get(b.nights) ?? 0) + 1);
  const losBuckets = [...losMap.entries()]
    .map(([nights, bookings]) => ({ nights, bookings }))
    .sort((a, b) => a.nights - b.nights);

  // Day-of-week view. This is where most rate opportunities hide: a flat rate
  // across a week whose demand is anything but flat.
  const dayOfWeek = DOW_LABELS.map((label, dow) => {
    const dowCells = args.cells.filter(
      (c) => new Date(`${c.stayDate}T00:00:00Z`).getUTCDay() === dow,
    );
    const dowDates = new Set(dowCells.map((c) => c.stayDate));
    const dowNights = dowDates.size;
    const dowSold = sold.filter((b) => {
      for (let i = 0; i < b.nights; i++) {
        const d = new Date(`${b.checkIn}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + i);
        if (d.getUTCDay() === dow) return true;
      }
      return false;
    });
    const dowRoomNights = dowSold.length;
    const dowAvailable = totalRooms * dowNights;
    const dowRevenue = dowSold.reduce((s, b) => s + b.amount / b.nights, 0);
    const dowRates = dowCells.filter((c) => c.baseAmount != null).map((c) => c.baseAmount as number);
    return {
      dow,
      label,
      roomNightsAvailable: dowAvailable,
      roomNightsSold: dowRoomNights,
      occupancy: dowAvailable > 0 ? round2((dowRoomNights / dowAvailable) * 100) / 100 : null,
      adr: dowRoomNights > 0 ? round2(dowRevenue / dowRoomNights) : null,
      averageOfferedRate: dowRates.length
        ? round2(dowRates.reduce((s, n) => s + n, 0) / dowRates.length)
        : null,
    };
  });

  return {
    propertyId: args.propertyId,
    propertyName: args.propertyName,
    currency: args.currency,
    window,
    roomNightsAvailable,
    roomNightsSold,
    roomRevenue,
    occupancy,
    adr,
    revpar,
    bookingCount: sold.length,
    confidence: grade(sold.length),
    fxConvertedBookings: sold.filter((b) => b.converted).length,
    fxSource: args.fxSource ?? null,
    averageOfferedRate: rateSample.length
      ? round2(rateSample.reduce((s, n) => s + n, 0) / rateSample.length)
      : null,
    medianOfferedRate: median(rateSample),
    searches: args.searches,
    offersProduced: args.offers.length,
    lookToBook: args.searches > 0 ? round2((sold.length / args.searches) * 1000) / 1000 : null,
    leadTimeBuckets,
    losBuckets,
    dayOfWeek,
  };
}

export function computePartnerProduction(
  bookings: BookingFact[],
  partners: PartnerFact[],
): PartnerProduction[] {
  const confirmed = bookings.filter((b) => b.status === 'CONFIRMED');
  const totalRevenue = confirmed.reduce((s, b) => s + b.amount, 0);

  const byOrg = new Map<string, BookingFact[]>();
  for (const b of bookings) byOrg.set(b.buyerOrgId, [...(byOrg.get(b.buyerOrgId) ?? []), b]);

  const rows: PartnerProduction[] = [];
  for (const [orgId, all] of byOrg) {
    const partner = partners.find((p) => p.organizationId === orgId);
    const ok = all.filter((b) => b.status === 'CONFIRMED');
    const cancelled = all.filter((b) => b.status === 'CANCELLED');
    const roomNights = ok.reduce((s, b) => s + b.nights, 0);
    const revenue = round2(ok.reduce((s, b) => s + b.amount, 0));
    const commissionPct = partner?.commissionPct ?? null;

    rows.push({
      organizationId: orgId,
      name: partner?.name ?? orgId,
      type: partner?.type ?? 'UNKNOWN',
      country: partner?.country ?? '—',
      bookings: ok.length,
      roomNights,
      revenue,
      adr: roomNights > 0 ? round2(revenue / roomNights) : null,
      averageLos: ok.length ? round2(roomNights / ok.length) : null,
      averageLeadTimeDays: ok.length
        ? Math.round(
            ok.reduce(
              (s, b) =>
                s +
                Math.max(
                  0,
                  (new Date(`${b.checkIn}T00:00:00Z`).getTime() - b.createdAt.getTime()) /
                    86_400_000,
                ),
              0,
            ) / ok.length,
          )
        : null,
      cancellationRate: all.length ? round2((cancelled.length / all.length) * 100) / 100 : null,
      contractCode: partner?.contractCode ?? null,
      commissionPct,
      markupPct: partner?.markupPct ?? null,
      // The number that should drive the decision: gross production flatters a
      // high-commission channel that is actually worth less per room night.
      netRevenue:
        commissionPct != null
          ? round2(new Decimal(revenue).mul(100 - commissionPct).div(100).toNumber())
          : revenue,
      share: totalRevenue > 0 ? round2((revenue / totalRevenue) * 1000) / 1000 : 0,
    });
  }

  return rows.sort((a, b) => b.revenue - a.revenue);
}

export interface AdviseArgs {
  metrics: RevenueMetrics;
  competitive: CompetitivePosition;
  partners: PartnerProduction[];
  cells: EffectiveAriRow[];
  now: Date;
  /** Freshness/connectivity problems make every other number unreliable. */
  dataIssues: string[];
}

export function advise(args: AdviseArgs): RevenueAdvisory {
  const { metrics: m, competitive, partners } = args;
  const findings: AdvisoryFinding[] = [];
  const cur = m.currency;

  // ── 0. Data quality first. Nothing else is worth saying on bad data. ──
  if (args.dataIssues.length) {
    findings.push({
      code: 'DATA_QUALITY',
      lever: 'DATA',
      severity: 'CRITICAL',
      title: 'Fix the data before acting on any of these numbers',
      detail: `${args.dataIssues.length} data problem(s) affect this window: ${args.dataIssues.join(' ')} Rate and occupancy figures computed on incomplete inventory will point you the wrong way.`,
      evidence: { issues: args.dataIssues },
      confidence: 'HIGH',
    });
  }

  const staleCells = args.cells.filter((c) => c.stale).length;
  if (staleCells > 0 && args.cells.length > 0) {
    const pct = Math.round((staleCells / args.cells.length) * 100);
    findings.push({
      code: 'STALE_INVENTORY',
      lever: 'CONNECTIVITY',
      severity: pct > 25 ? 'CRITICAL' : 'WARNING',
      title: `${pct}% of inventory in this window is past its freshness SLA`,
      detail: `${staleCells} of ${args.cells.length} rate cells have not been refreshed inside the SLA. Buyers may be seeing prices the hotel no longer intends to sell at.`,
      evidence: { staleCells, totalCells: args.cells.length, pct },
      confidence: 'HIGH',
    });
  }

  // ── 1. The confidence gate. ──
  if (m.confidence === 'NONE' || m.confidence === 'LOW') {
    findings.push({
      code: 'INSUFFICIENT_DEMAND_DATA',
      lever: 'DATA',
      severity: 'INFO',
      title:
        m.bookingCount === 0
          ? 'No confirmed bookings in this window'
          : `Only ${m.bookingCount} confirmed booking(s) in this window`,
      detail:
        `Occupancy, ADR and RevPAR need at least ${MIN_BOOKINGS_FOR_DEMAND} bookings before they describe demand rather than noise. ` +
        `I can still tell you what you are offering and how it is priced against the market — those are observable today — but I will not recommend a rate move on this sample.`,
      evidence: { bookingCount: m.bookingCount, threshold: MIN_BOOKINGS_FOR_DEMAND },
      confidence: 'HIGH',
    });
  }

  // ── 2. What is limiting RevPAR: rate or occupancy? ──
  if (m.occupancy != null && m.adr != null && m.revpar != null && m.confidence !== 'LOW' && m.confidence !== 'NONE') {
    const occPct = Math.round(m.occupancy * 100);
    const rateLed = competitive.deltaPct != null && competitive.deltaPct < -5;
    findings.push({
      code: 'REVPAR_DECOMPOSITION',
      lever: 'RATE',
      severity: 'INFO',
      title: `RevPAR ${fmt(m.revpar, cur)} = ADR ${fmt(m.adr, cur)} × ${occPct}% occupancy`,
      detail:
        occPct >= 75
          ? `You are filling the hotel. At ${occPct}% occupancy the constraint is rate, not volume — every point of ADR falls straight to RevPAR.`
          : occPct <= 45
            ? `At ${occPct}% occupancy the constraint is volume. Lifting ADR on empty nights moves nothing; the lever is demand — distribution reach and restrictions before price.`
            : `At ${occPct}% you have room on both levers. ${rateLed ? 'Your rate sits below the market, so rate is the cheaper move.' : 'Look at which dates are actually tight before moving anything blanket.'}`,
      evidence: { revpar: m.revpar, adr: m.adr, occupancy: m.occupancy },
      confidence: m.confidence,
    });
  }

  // ── 3. Rate position against the market. ──
  if (competitive.deltaPct != null && competitive.sampleSize >= 10) {
    const d = competitive.deltaPct;
    const occPct = m.occupancy != null ? Math.round(m.occupancy * 100) : null;

    if (d > 8 && (occPct == null || occPct < 60)) {
      findings.push({
        code: 'PRICED_ABOVE_MARKET',
        lever: 'PROMOTION',
        severity: 'OPPORTUNITY',
        title: `Priced ${d}% above the comparable set with ${occPct ?? '—'}% occupancy`,
        detail:
          `Your average rate is ${fmt(m.averageOfferedRate, cur)} against a peer median of ${fmt(competitive.medianPeerRate, cur)}. ` +
          `This is a commercial gap, not a technical one — connectivity and inventory are not the problem. ` +
          `A geo-fenced or agency-specific promotion closes the gap for the segments that are price-sensitive without moving your public BAR, which protects parity and your rate integrity everywhere else.`,
        evidence: {
          ourRate: m.averageOfferedRate,
          peerMedian: competitive.medianPeerRate,
          deltaPct: d,
          sampleSize: competitive.sampleSize,
        },
        confidence: competitive.sampleSize >= 40 ? 'HIGH' : 'MEDIUM',
      });
    }

    if (d < -8 && occPct != null && occPct > 70) {
      findings.push({
        code: 'PRICED_BELOW_MARKET',
        lever: 'RATE',
        severity: 'OPPORTUNITY',
        title: `Priced ${Math.abs(d)}% below the comparable set while running ${occPct}% occupancy`,
        detail:
          `You are filling at ${fmt(m.averageOfferedRate, cur)} while peers sit at ${fmt(competitive.medianPeerRate, cur)}. ` +
          `Selling out below market is the most expensive kind of full. Lift the tightest dates first rather than the whole window — a blanket rise costs you the soft dates you were winning on price.`,
        evidence: { ourRate: m.averageOfferedRate, peerMedian: competitive.medianPeerRate, deltaPct: d },
        confidence: competitive.sampleSize >= 40 ? 'HIGH' : 'MEDIUM',
      });
    }
  }

  // ── 4. Day-of-week rate flatness against day-of-week demand. ──
  const priced = m.dayOfWeek.filter((d) => d.averageOfferedRate != null);
  if (priced.length >= 5) {
    const rates = priced.map((d) => d.averageOfferedRate as number);
    const spread = (Math.max(...rates) - Math.min(...rates)) / Math.max(...rates);
    const withOcc = m.dayOfWeek.filter((d) => d.occupancy != null && d.roomNightsAvailable > 0);
    const occSpread = withOcc.length
      ? Math.max(...withOcc.map((d) => d.occupancy as number)) -
        Math.min(...withOcc.map((d) => d.occupancy as number))
      : 0;

    if (spread < 0.08 && occSpread > 0.2 && m.confidence !== 'NONE' && m.confidence !== 'LOW') {
      const best = [...withOcc].sort((a, b) => (b.occupancy ?? 0) - (a.occupancy ?? 0))[0];
      findings.push({
        code: 'FLAT_RATE_UNEVEN_DEMAND',
        lever: 'RATE',
        severity: 'OPPORTUNITY',
        title: 'Your rate is flat across the week; your demand is not',
        detail:
          `Rates vary by only ${Math.round(spread * 100)}% across the week while occupancy varies by ${Math.round(occSpread * 100)} points. ` +
          `${best.label} is your strongest day at ${Math.round((best.occupancy ?? 0) * 100)}% — it is carrying the same price as your weakest. Day-of-week pricing is the lowest-risk ADR gain available to you.`,
        evidence: { rateSpreadPct: Math.round(spread * 100), occupancySpreadPoints: Math.round(occSpread * 100), strongestDay: best.label },
        confidence: m.confidence,
      });
    }
  }

  // ── 5. Restrictions blocking arrivals. ──
  const ctaDates = [...new Set(args.cells.filter((c) => c.closedToArrival && c.open).map((c) => c.stayDate))].sort();
  if (ctaDates.length) {
    findings.push({
      code: 'CTA_BLOCKING',
      lever: 'RESTRICTION',
      severity: 'WARNING',
      title: `Closed to arrival on ${ctaDates.length} date(s) that otherwise have inventory`,
      detail:
        `A buyer searching a stay that starts on one of these dates does not see a higher price — they do not see the hotel at all. ` +
        `Closed-to-arrival is worth keeping only where it protects a genuine multi-night pattern; on isolated dates it just removes you from the result set.`,
      evidence: { dates: ctaDates.slice(0, 14), count: ctaDates.length },
      confidence: 'HIGH',
      suggestedCommandLabel: 'Lift closed-to-arrival on these dates',
      suggestedCommand: {
        kind: 'update_restriction',
        target: {
          propertyId: m.propertyId,
          roomTypeCodes: null,
          ratePlanCodes: null,
          from: ctaDates[0],
          to: ctaDates[ctaDates.length - 1],
          daysOfWeek: null,
          occupancy: null,
        },
        restriction: { closedToArrival: false },
        reason: 'Revenue advisory: closed-to-arrival is removing the hotel from search results',
      } as StructuredCommand,
    });
  }

  // ── 6. Minimum stay against observed length of stay. ──
  const minLosCells = args.cells.filter((c) => c.minLos > 1);
  if (minLosCells.length && m.losBuckets.length) {
    const shortStays = m.losBuckets.filter((b) => b.nights === 1).reduce((s, b) => s + b.bookings, 0);
    const totalStays = m.losBuckets.reduce((s, b) => s + b.bookings, 0);
    if (totalStays > 0 && shortStays / totalStays > 0.4) {
      const maxMin = Math.max(...minLosCells.map((c) => c.minLos));
      findings.push({
        code: 'MINLOS_AGAINST_PATTERN',
        lever: 'RESTRICTION',
        severity: 'OPPORTUNITY',
        title: `A ${maxMin}-night minimum is fighting your actual booking pattern`,
        detail:
          `${Math.round((shortStays / totalStays) * 100)}% of what you sell is a single night, yet ${minLosCells.length} rate cell(s) require ${maxMin} nights. ` +
          `Minimum stay earns its place around genuine compression dates. Applied broadly it turns your most common booking into a rejected search.`,
        evidence: { singleNightShare: shortStays / totalStays, cellsWithMinLos: minLosCells.length, maxMinLos: maxMin },
        confidence: m.confidence,
      });
    }
  }

  // ── 7. Lead time — which promotion type actually fits. ──
  const totalLead = m.leadTimeBuckets.reduce((s, b) => s + b.bookings, 0);
  if (totalLead >= MIN_BOOKINGS_FOR_DEMAND) {
    const shortLead = m.leadTimeBuckets
      .filter((b) => b.maxDays != null && b.maxDays <= 7)
      .reduce((s, b) => s + b.bookings, 0);
    const longLead = m.leadTimeBuckets
      .filter((b) => b.minDays >= 22)
      .reduce((s, b) => s + b.bookings, 0);

    if (shortLead / totalLead > 0.55) {
      findings.push({
        code: 'SHORT_BOOKING_WINDOW',
        lever: 'PROMOTION',
        severity: 'OPPORTUNITY',
        title: `${Math.round((shortLead / totalLead) * 100)}% of bookings arrive within a week of arrival`,
        detail:
          `Your demand is almost entirely last-minute, which means you are carrying inventory to within days of arrival with no committed base. ` +
          `An early-booking promotion targets a segment you barely have today — it builds base rather than discounting demand you were going to get anyway. ` +
          `The discount only pays out on bookings made ahead of the window you are currently missing.`,
        evidence: { shortLeadShare: shortLead / totalLead, buckets: m.leadTimeBuckets },
        confidence: m.confidence,
      });
    } else if (longLead / totalLead > 0.6) {
      findings.push({
        code: 'LONG_BOOKING_WINDOW',
        lever: 'PROMOTION',
        severity: 'INFO',
        title: `${Math.round((longLead / totalLead) * 100)}% of bookings arrive more than three weeks out`,
        detail:
          `You already have a committed base. An early-booking discount here mostly pays a discount to people who were going to book anyway. ` +
          `Your remaining upside is in the last-minute window and in closing the gaps that the base leaves behind.`,
        evidence: { longLeadShare: longLead / totalLead, buckets: m.leadTimeBuckets },
        confidence: m.confidence,
      });
    }
  }

  // ── 8. Distribution mix: gross production lies. ──
  if (partners.length >= 2) {
    const top = partners[0];
    if (top.share > 0.6) {
      findings.push({
        code: 'PARTNER_CONCENTRATION',
        lever: 'DISTRIBUTION',
        severity: 'WARNING',
        title: `${top.name} is ${Math.round(top.share * 100)}% of your production`,
        detail:
          `One partner carrying most of the book is a commercial risk before it is a revenue problem: their renegotiation is your whole quarter. ` +
          `Broadening reach matters more than squeezing rate here.`,
        evidence: { partner: top.name, share: top.share },
        confidence: m.confidence,
      });
    }

    const byNetAdr = partners
      .filter((p) => p.adr != null && p.bookings > 0)
      .map((p) => ({
        ...p,
        netAdr: p.netRevenue != null && p.roomNights > 0 ? p.netRevenue / p.roomNights : null,
      }))
      .filter((p) => p.netAdr != null)
      .sort((a, b) => (b.netAdr as number) - (a.netAdr as number));

    if (byNetAdr.length >= 2) {
      const best = byNetAdr[0];
      const worst = byNetAdr[byNetAdr.length - 1];
      const gap = ((best.netAdr as number) - (worst.netAdr as number)) / (worst.netAdr as number);
      if (gap > 0.15) {
        findings.push({
          code: 'PARTNER_NET_VALUE_GAP',
          lever: 'DISTRIBUTION',
          severity: 'OPPORTUNITY',
          title: `${best.name} is worth ${Math.round(gap * 100)}% more per room night than ${worst.name}, net of commission`,
          detail:
            `${best.name}: ${fmt(best.netAdr, cur)} net ADR across ${best.bookings} booking(s) at ${best.commissionPct ?? 0}% commission. ` +
            `${worst.name}: ${fmt(worst.netAdr, cur)} net at ${worst.commissionPct ?? 0}%. ` +
            `Gross production ranks them the other way round, which is why blanket discounts destroy margin: a targeted net rate or an agency-exclusive promotion for ${best.name} buys volume where it is actually worth having.`,
          evidence: {
            best: { name: best.name, netAdr: best.netAdr, commissionPct: best.commissionPct },
            worst: { name: worst.name, netAdr: worst.netAdr, commissionPct: worst.commissionPct },
            gapPct: Math.round(gap * 100),
          },
          confidence: m.confidence === 'HIGH' ? 'HIGH' : 'MEDIUM',
        });
      }
    }
  }

  // ── 9. Visibility without conversion. ──
  if (m.searches > 50 && m.bookingCount === 0) {
    findings.push({
      code: 'SEARCHED_NOT_BOOKED',
      lever: 'RATE',
      severity: 'WARNING',
      title: `${m.searches} searches produced ${m.offersProduced} offers and no bookings`,
      detail:
        `You are visible and you are being priced. Conversion is the failure, not distribution. ` +
        `That points at rate, at cancellation terms, or at a room/rate mix that does not match what these buyers are searching for.`,
      evidence: { searches: m.searches, offers: m.offersProduced, bookings: 0 },
      confidence: 'MEDIUM',
    });
  }

  // ── 10. Inventory being withheld. ──
  const closedWithRooms = args.cells.filter((c) => !c.open && c.available > 0).length;
  if (closedWithRooms > 0) {
    findings.push({
      code: 'CLOSED_WITH_INVENTORY',
      lever: 'INVENTORY',
      severity: 'WARNING',
      title: `${closedWithRooms} date(s) are closed while still holding inventory`,
      detail:
        `These dates have rooms but are not sellable. Either a stop-sell outlived its reason or the channel manager is sending a close it does not mean.`,
      evidence: { cells: closedWithRooms },
      confidence: 'HIGH',
    });
  }

  return {
    propertyId: m.propertyId,
    propertyName: m.propertyName,
    window: m.window,
    metrics: m,
    competitive,
    partners,
    findings,
    headline: buildHeadline(m, competitive, findings),
    generatedAt: args.now.toISOString(),
  };
}

function buildHeadline(
  m: RevenueMetrics,
  competitive: CompetitivePosition,
  findings: AdvisoryFinding[],
): string {
  const cur = m.currency;
  const critical = findings.filter((f) => f.severity === 'CRITICAL');
  if (critical.length) {
    return `${m.propertyName}: ${critical[0].title}. Nothing commercial is worth deciding until that is cleared.`;
  }

  if (m.confidence === 'NONE') {
    const priced = m.averageOfferedRate != null;
    return (
      `${m.propertyName} has no confirmed bookings between ${m.window.from} and ${m.window.to}. ` +
      (priced
        ? `You are offering ${m.roomNightsAvailable} room nights at an average of ${fmt(m.averageOfferedRate, cur)}` +
          (competitive.deltaPct != null
            ? `, which is ${competitive.deltaPct > 0 ? `${competitive.deltaPct}% above` : `${Math.abs(competitive.deltaPct)}% below`} the comparable set. `
            : '. ') +
          `I can advise on price position and restrictions; demand-based recommendations need bookings first.`
        : `There is no priced inventory to assess yet.`)
    );
  }

  const occPct = m.occupancy != null ? Math.round(m.occupancy * 100) : null;
  const opportunities = findings.filter((f) => f.severity === 'OPPORTUNITY');
  return (
    `${m.propertyName} ran ${occPct}% occupancy at ${fmt(m.adr, cur)} ADR for a RevPAR of ${fmt(m.revpar, cur)} ` +
    `across ${m.window.nights} nights, on ${m.bookingCount} booking(s) — confidence ${m.confidence.toLowerCase()}. ` +
    (opportunities.length
      ? `The clearest opportunity: ${opportunities[0].title.toLowerCase()}.`
      : `No standout opportunity in this window.`)
  );
}

function fmt(n: number | null | undefined, currency: string): string {
  if (n == null) return '—';
  const zeroDecimal = ['COP', 'CLP', 'JPY', 'KRW', 'PYG', 'VND'].includes(currency);
  return `${new Intl.NumberFormat('en-US', {
    maximumFractionDigits: zeroDecimal ? 0 : 2,
  }).format(n)} ${currency}`;
}
