/**
 * Revenue management analytics.
 *
 * Every metric carries its own sample size and a confidence grade. That is not
 * decoration: a revenue recommendation built on four bookings is worse than no
 * recommendation, because someone will act on it. The advisory engine refuses
 * to make demand-based recommendations below a threshold and says so.
 *
 * Definitions are fixed here so a number never means two things:
 *   occupancy = roomNightsSold / roomNightsAvailable
 *   ADR       = roomRevenue / roomNightsSold
 *   RevPAR    = roomRevenue / roomNightsAvailable  ( = ADR x occupancy )
 *
 * RevPAR is deliberately computed from revenue and capacity directly rather
 * than multiplying two rounded numbers.
 */

export type Confidence = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

export interface MetricWindow {
  from: string;
  to: string;
  nights: number;
}

export interface RevenueMetrics {
  propertyId: string;
  propertyName: string;
  currency: string;
  window: MetricWindow;

  roomNightsAvailable: number;
  roomNightsSold: number;
  roomRevenue: number;

  occupancy: number | null;
  adr: number | null;
  revpar: number | null;

  /** Bookings behind these numbers. The honesty gate for everything below. */
  bookingCount: number;
  confidence: Confidence;

  /**
   * Bookings whose amount had to be converted into the property currency to be
   * aggregated. Summing MXN and COP into one ADR is silently wrong, so the
   * conversion is explicit and its count is reported.
   */
  fxConvertedBookings: number;
  fxSource: string | null;

  /** Rate the market is being shown, whether or not it sold. */
  averageOfferedRate: number | null;
  medianOfferedRate: number | null;

  searches: number;
  offersProduced: number;
  lookToBook: number | null;

  /** Distribution of lead time, in days, for what did sell. */
  leadTimeBuckets: Array<{ label: string; minDays: number; maxDays: number | null; bookings: number }>;
  losBuckets: Array<{ nights: number; bookings: number }>;

  dayOfWeek: Array<{
    dow: number;
    label: string;
    roomNightsAvailable: number;
    roomNightsSold: number;
    occupancy: number | null;
    adr: number | null;
    averageOfferedRate: number | null;
  }>;
}

export interface CompetitivePosition {
  medianPeerRate: number | null;
  ourAverageRate: number | null;
  deltaPct: number | null;
  sampleSize: number;
  basis: string;
}

/** What a hotel actually gets from each buyer, which is never the same thing
 *  as what each buyer promises. */
export interface PartnerProduction {
  organizationId: string;
  name: string;
  type: string;
  country: string;
  bookings: number;
  roomNights: number;
  revenue: number;
  adr: number | null;
  averageLos: number | null;
  averageLeadTimeDays: number | null;
  cancellationRate: number | null;
  contractCode: string | null;
  commissionPct: number | null;
  markupPct: number | null;
  /** Revenue net of commission — the number that should drive the decision. */
  netRevenue: number | null;
  share: number;
}

export type AdvisoryLever =
  | 'RATE'
  | 'INVENTORY'
  | 'RESTRICTION'
  | 'PROMOTION'
  | 'DISTRIBUTION'
  | 'CONNECTIVITY'
  | 'DATA';

export interface AdvisoryFinding {
  code: string;
  lever: AdvisoryLever;
  severity: 'INFO' | 'OPPORTUNITY' | 'WARNING' | 'CRITICAL';
  title: string;
  /** The reasoning, with the actual numbers in it. */
  detail: string;
  evidence: Record<string, unknown>;
  confidence: Confidence;
  /** A StructuredCommand the operator can approve in one click, when the
   *  finding maps cleanly onto an action we are allowed to take. */
  suggestedCommand?: unknown;
  suggestedCommandLabel?: string;
}

export interface RevenueAdvisory {
  propertyId: string;
  propertyName: string;
  window: MetricWindow;
  metrics: RevenueMetrics;
  competitive: CompetitivePosition;
  partners: PartnerProduction[];
  findings: AdvisoryFinding[];
  /** One paragraph a human can read aloud in a morning meeting. */
  headline: string;
  generatedAt: string;
}
