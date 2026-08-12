/**
 * Sellability.
 *
 * A boolean is not a diagnosis. Every predicate reports its own result,
 * the evidence behind it, who owns fixing it and what the remediation is —
 * which is what turns "why am I not selling?" from a support ticket into
 * an answer the platform gives by itself.
 */
export type SellabilityPredicateCode =
  | 'PROPERTY_APPROVED'
  | 'MAPPING_ACTIVE'
  | 'ARI_FRESH'
  | 'AVAILABILITY_POSITIVE'
  | 'PROPERTY_OPEN'
  | 'RESTRICTIONS_SATISFIED'
  | 'PRICE_VALID'
  | 'CONTRACT_ACTIVE'
  | 'BUYER_ELIGIBLE';

export type PredicateOwner =
  | 'Connectivity'
  | 'Catalog'
  | 'Commercial'
  | 'Supplier'
  | 'Pricing'
  | 'Distribution';

export interface PredicateResult {
  code: SellabilityPredicateCode;
  ok: boolean;
  /** Null when the predicate could not be evaluated (missing input), which is
   *  materially different from "evaluated and failed". */
  evaluated: boolean;
  label: string;
  evidence: Record<string, unknown>;
  owner: PredicateOwner;
  remediation?: string;
  /** Whether the platform can fix this itself given the right autonomy. */
  autoFixable: boolean;
}

export interface SellabilityResult {
  sellable: boolean;
  predicates: PredicateResult[];
  failedCodes: SellabilityPredicateCode[];
  evaluatedAt: string;
}

export interface SellabilityContext {
  now: Date;
  freshnessSlaSeconds: number;
  propertyStatus: string;
  mappingActive: boolean;
  mappingVersion?: number | null;
  contract?: {
    id: string;
    status: string;
    validFrom: string;
    validTo: string;
    markets: string[];
    channels: string[];
    propertyIds: string[];
  } | null;
  buyer?: { organizationId: string; market: string; channel: string } | null;
  /** Stay context. Absent when evaluating a bare calendar cell — the
   *  arrival/departure predicates then report evaluated:false rather than
   *  silently passing. */
  stay?: { checkIn: string; checkOut: string; nights: number; isArrival: boolean; isDeparture: boolean } | null;
}

/**
 * The funnel behind "why am I not selling?". Each stage carries its own count,
 * so the drop is attributable rather than merely visible.
 */
export interface DiagnosticFunnelStage {
  stage:
    | 'SEARCHES'
    | 'MAPPED'
    | 'FRESH_ARI'
    | 'INVENTORY'
    | 'RESTRICTIONS'
    | 'CONTRACT'
    | 'BUYER_ELIGIBILITY'
    | 'PRICE_COMPETITIVENESS'
    | 'CONVERSION';
  label: string;
  passed: number;
  total: number;
  ok: boolean;
  detail?: string;
}

export interface DiagnosticReport {
  propertyId: string;
  propertyName: string;
  window: { from: string; to: string };
  funnel: DiagnosticFunnelStage[];
  findings: Array<{
    code: string;
    severity: 'INFO' | 'WARNING' | 'CRITICAL';
    title: string;
    detail: string;
    owner: PredicateOwner;
    autoFixable: boolean;
    /** A StructuredCommand the operator can approve in one click. */
    suggestedCommand?: unknown;
  }>;
  summary: string;
  generatedAt: string;
}
