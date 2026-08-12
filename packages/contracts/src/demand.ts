/**
 * Demand intelligence.
 *
 * The point is not "how many searches happened". It is:
 *
 *   Which buyer looked at MY hotel, how often, and what did they see?
 *   When they did not book, what stopped them — us or the price?
 *   Where are travellers from my market actually going?
 *
 * That last one is the outbound/inbound view a Colombian wholesaler needs to
 * plan contracting, and it is derivable from our own search and booking flow
 * without buying anyone's panel data — as long as we record an impression per
 * property per search, which is what `SearchImpression` exists for.
 *
 * Every figure here carries its own sample size. A "top destination" computed
 * from nine searches is a coincidence, not a trend.
 */

export interface DemandWindow {
  from: string;
  to: string;
  days: number;
}

/** What one buyer did with one hotel. */
export interface BuyerDemandRow {
  buyerOrgId: string;
  buyerName: string;
  buyerType: string;
  partnerCode: string | null;
  sourceMarket: string;
  impressions: number;
  offered: number;
  /** Impressions that produced no offer, and the predicate that stopped them. */
  blocked: number;
  topBlockers: Array<{ code: string; count: number }>;
  bookings: number;
  roomNights: number;
  revenue: number;
  currency: string;
  /** offered / impressions — are we even able to quote them? */
  quoteRate: number | null;
  /** bookings / offered — when we quote, do they buy? */
  conversionRate: number | null;
  averageLeadTimeDays: number | null;
  lastSeenAt: string | null;
}

export interface PropertyDemandReport {
  propertyId: string;
  propertyName: string;
  window: DemandWindow;
  impressions: number;
  offered: number;
  bookings: number;
  quoteRate: number | null;
  conversionRate: number | null;
  /** Buyers ranked by impressions, so "who is looking and not buying" is the
   *  first thing visible. */
  buyers: BuyerDemandRow[];
  /** Where the demand is coming FROM. */
  sourceMarkets: Array<{ market: string; impressions: number; bookings: number; share: number }>;
  /** Which stay dates are being searched, whether or not we could quote them. */
  demandByStayDate: Array<{ stayDate: string; impressions: number; offered: number }>;
  /** Aggregate reasons we failed to quote. The actionable list. */
  blockers: Array<{ code: string; count: number; share: number }>;
  sampleSize: number;
  confidence: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
  findings: string[];
  generatedAt: string;
}

/**
 * Outbound (emisivo): travellers leaving a market.
 * Inbound (receptivo): travellers arriving at a destination.
 *
 * Both are computed from the same impression and booking flow, read from
 * opposite ends.
 */
export interface TravelFlowRow {
  sourceMarket: string;
  destinationCountry: string;
  destinationCity: string;
  impressions: number;
  bookings: number;
  roomNights: number;
  revenue: number;
  currency: string;
  averageRate: number | null;
  averageLos: number | null;
  averageLeadTimeDays: number | null;
  share: number;
  /** Change in impressions against the immediately preceding window of the
   *  same length. Null when the prior window has too little data to compare. */
  trendPct: number | null;
}

export interface TravelFlowReport {
  direction: 'OUTBOUND' | 'INBOUND';
  /** For OUTBOUND: the market travellers are leaving. For INBOUND: the country
   *  they are arriving in. */
  anchor: string;
  window: DemandWindow;
  rows: TravelFlowRow[];
  totalImpressions: number;
  totalBookings: number;
  sampleSize: number;
  confidence: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
  /** Written from the numbers above, not from a model. */
  findings: string[];
  basis: string;
  generatedAt: string;
}
