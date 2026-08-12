import { z } from 'zod';
import { ISO_DATE, StayDate } from './ids';

/**
 * ARI canonical model.
 *
 * Two rules the whole platform depends on:
 *  1. EXTERNAL is what the supplier said. It is never edited, only appended to.
 *  2. MANAGED is what a human or agent decided. It lives alongside EXTERNAL and
 *     never overwrites it. Effective is a computed projection of both.
 *
 * Contractual and promotional adjustments deliberately do NOT appear here —
 * they belong to offer construction, not to the inventory ledger.
 */
export const AriLayerSchema = z.enum(['EXTERNAL', 'MANAGED']);
export type AriLayer = z.infer<typeof AriLayerSchema>;

export const AriEventTypeSchema = z.enum([
  'RATE_UPDATED',
  'AVAILABILITY_UPDATED',
  'RESTRICTION_UPDATED',
  'FULL_SYNC',
]);
export type AriEventType = z.infer<typeof AriEventTypeSchema>;

/** The mutable-looking part of a cell. Every field is optional: a supplier may
 *  send a price without touching availability, and a partial update must not
 *  be read as "the rest is now null". */
export const AriValuesSchema = z.object({
  allotment: z.number().int().min(0).nullish(),
  available: z.number().int().min(0).nullish(),
  sold: z.number().int().min(0).nullish(),
  overbookingLimit: z.number().int().min(0).nullish(),

  currency: z.string().length(3).nullish(),
  baseAmount: z.number().nonnegative().nullish(),
  adultPrices: z.record(z.string(), z.number().nonnegative()).nullish(),
  childPrices: z.record(z.string(), z.number().nonnegative()).nullish(),

  open: z.boolean().nullish(),
  stopSell: z.boolean().nullish(),
  closedToArrival: z.boolean().nullish(),
  closedToDeparture: z.boolean().nullish(),

  minLos: z.number().int().min(1).max(365).nullish(),
  maxLos: z.number().int().min(1).max(365).nullish(),
  releaseDays: z.number().int().min(0).max(365).nullish(),
  bookingGap: z.number().int().min(0).max(365).nullish(),
});
export type AriValues = z.infer<typeof AriValuesSchema>;

export const ARI_VALUE_FIELDS = Object.keys(AriValuesSchema.shape) as (keyof AriValues)[];

/**
 * The canonical event an adapter must produce. Adapters translate provider
 * payloads into THIS and nothing else — no provider vocabulary ever reaches
 * the core.
 */
export const NormalizedAriEventSchema = z.object({
  tenantId: z.string().min(1),
  propertyId: z.string().min(1),
  roomTypeId: z.string().min(1),
  ratePlanId: z.string().min(1),
  stayDate: z.string().regex(ISO_DATE),
  occupancy: z.number().int().min(1).max(12).default(2),
  layer: AriLayerSchema,
  eventType: AriEventTypeSchema,
  source: z.string().min(1),
  /** Provider-supplied monotonic sequence, when the provider offers one.
   *  Its absence is why we also keep sourceTimestamp. */
  sourceSequence: z.union([z.number(), z.bigint()]).nullish(),
  sourceTimestamp: z.coerce.date(),
  values: AriValuesSchema,
  mappingVersion: z.number().int().nullish(),
  correlationId: z.string().min(1),
  rawEnvelopeId: z.string().nullish(),
  actorType: z.enum(['CONNECTOR', 'USER', 'AGENT', 'SYSTEM']).default('CONNECTOR'),
  actorId: z.string().nullish(),
  reason: z.string().nullish(),
  /** Managed-layer overrides are time-bounded by design. */
  validFrom: z.coerce.date().nullish(),
  validTo: z.coerce.date().nullish(),
});
export type NormalizedAriEvent = z.infer<typeof NormalizedAriEventSchema>;

export const AriIngestResultSchema = z.object({
  accepted: z.number().int(),
  duplicates: z.number().int(),
  outOfOrder: z.number().int(),
  rejected: z.number().int(),
  cellsTouched: z.number().int(),
  rejections: z.array(
    z.object({ index: z.number().int(), reason: z.string(), detail: z.string().optional() }),
  ),
  correlationId: z.string(),
});
export type AriIngestResult = z.infer<typeof AriIngestResultSchema>;

/** Per-field provenance attached to every Effective ARI row. This is what lets
 *  an operator ask "why is this price 137.50?" and get an answer. */
export interface FieldProvenance {
  layer: AriLayer;
  source: string;
  sourceTimestamp: string;
  eventId?: string;
}

export interface EffectiveAriRow {
  tenantId: string;
  propertyId: string;
  roomTypeId: string;
  ratePlanId: string;
  stayDate: StayDate;
  occupancy: number;

  currency: string | null;
  baseAmount: number | null;
  available: number;
  open: boolean;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  minLos: number;
  maxLos: number | null;
  releaseDays: number;
  bookingGap: number;

  freshnessSeconds: number;
  stale: boolean;

  explanation: {
    fields: Record<string, FieldProvenance>;
    layersPresent: AriLayer[];
    notes: string[];
  };

  externalVersion: number;
  managedVersion: number;
  version: number;
  computedAt: string;
}

/** ARI Health, with the thing the audited platform's screen was missing:
 *  freshness and root cause bolted to every metric. */
export interface AriHealthRow {
  roomTypeId: string;
  roomTypeCode: string;
  ratePlanId: string;
  ratePlanCode: string;
  datesCovered: number;
  datesExpected: number;
  coveragePct: number;
  gaps: StayDate[];
  freshnessSeconds: number | null;
  lastEventAt: string | null;
  lastSource: string | null;
  staleDates: number;
  closedDates: number;
  zeroAvailabilityDates: number;
  avgMinLos: number | null;
  maxMaxLos: number | null;
  rejectedLast24h: number;
  outOfOrderLast24h: number;
  status: 'HEALTHY' | 'DEGRADED' | 'BROKEN' | 'NO_DATA';
  causes: string[];
}

/**
 * Canonical projection of a cell's values for hashing.
 *
 * Every field is present, in a fixed order, with `null` for anything unset.
 * Without this, the hash of a freshly-created cell (only the fields the
 * supplier sent) differs from the hash of the same cell read back (all fields,
 * most of them null) — and an unchanged resend would look like a change
 * forever.
 */
export function canonicalAriValues(v: AriValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of ARI_VALUE_FIELDS) {
    const value = (v as any)[field];
    out[field] = value === undefined ? null : value;
  }
  return out;
}
