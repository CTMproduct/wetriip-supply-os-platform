import {
  BuyerDemandRow,
  DemandWindow,
  PropertyDemandReport,
  TravelFlowReport,
  TravelFlowRow,
} from '@wetriip/contracts';

/**
 * Demand intelligence engine.
 *
 * Built on one fact we record and nobody else can: an impression per property
 * per search, with the buyer, their source market, and — when we failed to
 * quote — the predicate that stopped us.
 *
 * That last field is what makes this different from a search counter. "2,400
 * searches, 0 bookings" is a mystery. "2,400 impressions, 1,900 of which never
 * produced an offer because the Junior Suite has no inventory" is a Tuesday
 * morning task.
 *
 * Every figure carries a sample size and a confidence grade. A top destination
 * derived from nine searches is a coincidence.
 */

const MIN_SAMPLE_LOW = 30;
const MIN_SAMPLE_MEDIUM = 200;
const MIN_SAMPLE_HIGH = 1000;

export interface ImpressionFact {
  propertyId: string;
  buyerOrgId: string;
  sourceMarket: string;
  destinationCountry: string;
  destinationCity: string;
  checkIn: string;
  nights: number;
  offered: boolean;
  offerCount: number;
  lowestRate: number | null;
  currency: string | null;
  blockedBy: string[];
  createdAt: Date;
}

export interface DemandBookingFact {
  propertyId: string;
  buyerOrgId: string;
  sourceMarket: string;
  destinationCountry: string;
  destinationCity: string;
  checkIn: string;
  nights: number;
  amount: number;
  currency: string;
  createdAt: Date;
}

export interface BuyerRef {
  organizationId: string;
  name: string;
  type: string;
  partnerCode: string | null;
}

function grade(n: number): 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' {
  if (n === 0) return 'NONE';
  if (n < MIN_SAMPLE_LOW) return 'LOW';
  if (n < MIN_SAMPLE_MEDIUM) return 'MEDIUM';
  return n < MIN_SAMPLE_HIGH ? 'MEDIUM' : 'HIGH';
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

function leadDays(checkIn: string, bookedAt: Date): number {
  return Math.max(
    0,
    Math.round((new Date(`${checkIn}T00:00:00Z`).getTime() - bookedAt.getTime()) / 86_400_000),
  );
}

export function buildPropertyDemand(args: {
  propertyId: string;
  propertyName: string;
  window: DemandWindow;
  impressions: ImpressionFact[];
  bookings: DemandBookingFact[];
  buyers: BuyerRef[];
  currency: string;
  now: Date;
}): PropertyDemandReport {
  const { impressions, bookings } = args;
  const offered = impressions.filter((i) => i.offered).length;

  // ── Per buyer ────────────────────────────────────────────
  const buyerIds = new Set([
    ...impressions.map((i) => i.buyerOrgId),
    ...bookings.map((b) => b.buyerOrgId),
  ]);

  const buyerRows: BuyerDemandRow[] = [...buyerIds].map((id) => {
    const ref = args.buyers.find((b) => b.organizationId === id);
    const mine = impressions.filter((i) => i.buyerOrgId === id);
    const theirs = bookings.filter((b) => b.buyerOrgId === id);
    const quoted = mine.filter((i) => i.offered).length;

    const blockerCounts = new Map<string, number>();
    for (const imp of mine.filter((i) => !i.offered)) {
      for (const code of imp.blockedBy) blockerCounts.set(code, (blockerCounts.get(code) ?? 0) + 1);
    }

    return {
      buyerOrgId: id,
      buyerName: ref?.name ?? id,
      buyerType: ref?.type ?? 'UNKNOWN',
      partnerCode: ref?.partnerCode ?? null,
      sourceMarket: mine[0]?.sourceMarket ?? '—',
      impressions: mine.length,
      offered: quoted,
      blocked: mine.length - quoted,
      topBlockers: [...blockerCounts.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 4),
      bookings: theirs.length,
      roomNights: theirs.reduce((s, b) => s + b.nights, 0),
      revenue: Math.round(theirs.reduce((s, b) => s + b.amount, 0) * 100) / 100,
      currency: args.currency,
      quoteRate: ratio(quoted, mine.length),
      conversionRate: ratio(theirs.length, quoted),
      averageLeadTimeDays: theirs.length
        ? Math.round(theirs.reduce((s, b) => s + leadDays(b.checkIn, b.createdAt), 0) / theirs.length)
        : null,
      lastSeenAt: mine.length
        ? new Date(Math.max(...mine.map((i) => i.createdAt.getTime()))).toISOString()
        : null,
    };
  });
  buyerRows.sort((a, b) => b.impressions - a.impressions);

  // ── Source markets ───────────────────────────────────────
  const marketMap = new Map<string, { impressions: number; bookings: number }>();
  for (const i of impressions) {
    const e = marketMap.get(i.sourceMarket) ?? { impressions: 0, bookings: 0 };
    e.impressions += 1;
    marketMap.set(i.sourceMarket, e);
  }
  for (const b of bookings) {
    const e = marketMap.get(b.sourceMarket) ?? { impressions: 0, bookings: 0 };
    e.bookings += 1;
    marketMap.set(b.sourceMarket, e);
  }
  const sourceMarkets = [...marketMap.entries()]
    .map(([market, v]) => ({
      market,
      impressions: v.impressions,
      bookings: v.bookings,
      share: impressions.length ? Math.round((v.impressions / impressions.length) * 1000) / 1000 : 0,
    }))
    .sort((a, b) => b.impressions - a.impressions);

  // ── Demand by stay date ──────────────────────────────────
  const dateMap = new Map<string, { impressions: number; offered: number }>();
  for (const i of impressions) {
    const e = dateMap.get(i.checkIn) ?? { impressions: 0, offered: 0 };
    e.impressions += 1;
    if (i.offered) e.offered += 1;
    dateMap.set(i.checkIn, e);
  }
  const demandByStayDate = [...dateMap.entries()]
    .map(([stayDate, v]) => ({ stayDate, ...v }))
    .sort((a, b) => a.stayDate.localeCompare(b.stayDate));

  // ── Blockers ─────────────────────────────────────────────
  const blockerCounts = new Map<string, number>();
  for (const i of impressions.filter((x) => !x.offered)) {
    for (const code of i.blockedBy) blockerCounts.set(code, (blockerCounts.get(code) ?? 0) + 1);
  }
  const blocked = impressions.length - offered;
  const blockers = [...blockerCounts.entries()]
    .map(([code, count]) => ({
      code,
      count,
      share: blocked ? Math.round((count / blocked) * 1000) / 1000 : 0,
    }))
    .sort((a, b) => b.count - a.count);

  // ── Findings ─────────────────────────────────────────────
  const findings: string[] = [];
  const confidence = grade(impressions.length);

  if (impressions.length === 0) {
    findings.push(
      'No buyer searched a stay that included this property in this window. Nothing downstream can explain the absence of bookings.',
    );
  } else {
    if (blockers.length && blocked / impressions.length > 0.3) {
      const top = blockers[0];
      findings.push(
        `${Math.round((blocked / impressions.length) * 100)}% of the demand that reached this hotel produced no offer at all, most often because of ${top.code} (${top.count} time(s)). That is a fixable loss before any pricing question.`,
      );
    }

    const lookers = buyerRows.filter((b) => b.impressions >= 10 && b.bookings === 0);
    if (lookers.length) {
      findings.push(
        `${lookers.length} buyer(s) looked repeatedly and never booked: ${lookers
          .slice(0, 3)
          .map((b) => `${b.buyerName} (${b.impressions} impressions, quoted ${Math.round((b.quoteRate ?? 0) * 100)}%)`)
          .join(', ')}.`,
      );
    }

    const best = buyerRows.filter((b) => b.conversionRate != null).sort((a, b) => (b.conversionRate ?? 0) - (a.conversionRate ?? 0))[0];
    if (best && (best.conversionRate ?? 0) > 0) {
      findings.push(
        `${best.buyerName} converts ${Math.round((best.conversionRate ?? 0) * 100)}% of what it is quoted. Opening more inventory to that profile is worth more than discounting to the rest.`,
      );
    }

    if (confidence === 'LOW') {
      findings.push(
        `Only ${impressions.length} impression(s) in this window — enough to see what is blocking quotes, not enough to read a trend.`,
      );
    }
  }

  return {
    propertyId: args.propertyId,
    propertyName: args.propertyName,
    window: args.window,
    impressions: impressions.length,
    offered,
    bookings: bookings.length,
    quoteRate: ratio(offered, impressions.length),
    conversionRate: ratio(bookings.length, offered),
    buyers: buyerRows,
    sourceMarkets,
    demandByStayDate,
    blockers,
    sampleSize: impressions.length,
    confidence,
    findings,
    generatedAt: args.now.toISOString(),
  };
}

/**
 * Outbound (emisivo) and inbound (receptivo) flow.
 *
 * Same data, read from opposite ends: OUTBOUND anchors on the market travellers
 * are leaving; INBOUND anchors on the country they are arriving in.
 *
 * The basis line is not decoration. This is OUR observed flow, not a national
 * tourism statistic, and a wholesaler planning contracting on it needs to know
 * the difference.
 */
export function buildTravelFlow(args: {
  direction: 'OUTBOUND' | 'INBOUND';
  anchor: string;
  window: DemandWindow;
  impressions: ImpressionFact[];
  bookings: DemandBookingFact[];
  /** The immediately preceding window of the same length, for the trend. */
  priorImpressions: ImpressionFact[];
  currency: string;
  now: Date;
}): TravelFlowReport {
  const key = (i: { sourceMarket: string; destinationCountry: string; destinationCity: string }) =>
    args.direction === 'OUTBOUND'
      ? `${i.destinationCountry}|${i.destinationCity}`
      : `${i.sourceMarket}|${i.destinationCity}`;

  const groups = new Map<
    string,
    { impressions: ImpressionFact[]; bookings: DemandBookingFact[] }
  >();

  for (const i of args.impressions) {
    const k = key(i);
    const e = groups.get(k) ?? { impressions: [], bookings: [] };
    e.impressions.push(i);
    groups.set(k, e);
  }
  for (const b of args.bookings) {
    const k = key(b);
    const e = groups.get(k) ?? { impressions: [], bookings: [] };
    e.bookings.push(b);
    groups.set(k, e);
  }

  const priorCounts = new Map<string, number>();
  for (const i of args.priorImpressions) {
    priorCounts.set(key(i), (priorCounts.get(key(i)) ?? 0) + 1);
  }

  const total = args.impressions.length;
  const rows: TravelFlowRow[] = [...groups.entries()].map(([, g]) => {
    const sample = g.impressions[0] ?? (g.bookings[0] as any);
    const roomNights = g.bookings.reduce((s, b) => s + b.nights, 0);
    const revenue = Math.round(g.bookings.reduce((s, b) => s + b.amount, 0) * 100) / 100;
    const prior = priorCounts.get(key(sample)) ?? 0;

    return {
      sourceMarket: sample?.sourceMarket ?? '—',
      destinationCountry: sample?.destinationCountry ?? '—',
      destinationCity: sample?.destinationCity ?? '—',
      impressions: g.impressions.length,
      bookings: g.bookings.length,
      roomNights,
      revenue,
      currency: args.currency,
      averageRate: roomNights > 0 ? Math.round((revenue / roomNights) * 100) / 100 : null,
      averageLos: g.bookings.length ? Math.round((roomNights / g.bookings.length) * 10) / 10 : null,
      averageLeadTimeDays: g.bookings.length
        ? Math.round(
            g.bookings.reduce((s, b) => s + leadDays(b.checkIn, b.createdAt), 0) / g.bookings.length,
          )
        : null,
      share: total ? Math.round((g.impressions.length / total) * 1000) / 1000 : 0,
      // A trend against a near-empty prior window is noise dressed as a signal.
      trendPct:
        prior >= 10
          ? Math.round(((g.impressions.length - prior) / prior) * 1000) / 10
          : null,
    };
  });

  rows.sort((a, b) => b.impressions - a.impressions);

  const findings: string[] = [];
  const confidence = grade(total);

  if (total === 0) {
    findings.push('No observed demand in this window.');
  } else {
    const top = rows[0];
    findings.push(
      args.direction === 'OUTBOUND'
        ? `Buyers selling from ${args.anchor} looked hardest at ${top.destinationCity}, ${top.destinationCountry} — ${Math.round(top.share * 100)}% of their searches.`
        : `Demand into ${args.anchor} came mostly from ${top.sourceMarket} — ${Math.round(top.share * 100)}% of searches.`,
    );

    const rising = rows.filter((r) => r.trendPct != null && r.trendPct > 25).slice(0, 3);
    if (rising.length) {
      findings.push(
        `Rising against the previous window: ${rising
          .map((r) => `${r.destinationCity} ${r.trendPct! > 0 ? '+' : ''}${r.trendPct}%`)
          .join(', ')}.`,
      );
    }

    const falling = rows.filter((r) => r.trendPct != null && r.trendPct < -25).slice(0, 3);
    if (falling.length) {
      findings.push(
        `Falling: ${falling.map((r) => `${r.destinationCity} ${r.trendPct}%`).join(', ')}.`,
      );
    }

    const searchedNotBooked = rows.filter((r) => r.impressions >= 20 && r.bookings === 0).slice(0, 3);
    if (searchedNotBooked.length) {
      findings.push(
        `Searched but never booked: ${searchedNotBooked
          .map((r) => `${r.destinationCity} (${r.impressions})`)
          .join(', ')}. Either we have no supply there or what we have is not competitive.`,
      );
    }

    if (confidence === 'LOW') {
      findings.push(
        `${total} impression(s) is a thin base. Treat the ranking as directional, not as a forecast.`,
      );
    }
  }

  return {
    direction: args.direction,
    anchor: args.anchor,
    window: args.window,
    rows,
    totalImpressions: total,
    totalBookings: args.bookings.length,
    sampleSize: total,
    confidence,
    findings,
    basis:
      'Derived from demand observed on this platform — searches our buyers ran and bookings they made. It is not a national tourism statistic and does not describe travel we never saw.',
    generatedAt: args.now.toISOString(),
  };
}
