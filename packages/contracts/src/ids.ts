import { createHash, randomUUID } from 'node:crypto';

/** Stable ISO date (yyyy-mm-dd) used as the ARI stay_date key component. */
export type StayDate = string;

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function toStayDate(d: Date | string): StayDate {
  if (typeof d === 'string') {
    if (ISO_DATE.test(d)) return d;
    return new Date(d).toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}

export function parseStayDate(d: StayDate): Date {
  return new Date(`${d}T00:00:00.000Z`);
}

export function addDays(d: StayDate, n: number): StayDate {
  const dt = parseStayDate(d);
  dt.setUTCDate(dt.getUTCDate() + n);
  return toStayDate(dt);
}

export function dateRange(from: StayDate, to: StayDate): StayDate[] {
  const out: StayDate[] = [];
  let cur = from;
  // Guard against pathological ranges; 1095 days = 3 years of inventory.
  for (let i = 0; i < 1095 && cur <= to; i++) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

export function nightsBetween(checkIn: StayDate, checkOut: StayDate): number {
  return Math.round(
    (parseStayDate(checkOut).getTime() - parseStayDate(checkIn).getTime()) / 86_400_000,
  );
}

export function newCorrelationId(): string {
  return `cid_${randomUUID()}`;
}

/**
 * The canonical ARI cell key. Every partition, index, lock, cache entry and
 * log line about ARI is derived from this exact ordering.
 */
export interface AriCellKey {
  tenantId: string;
  propertyId: string;
  roomTypeId: string;
  ratePlanId: string;
  stayDate: StayDate;
  occupancy: number;
}

export function ariCellKey(k: AriCellKey, layer?: string): string {
  const base = `${k.tenantId}/${k.propertyId}/${k.roomTypeId}/${k.ratePlanId}/${k.stayDate}/${k.occupancy}`;
  return layer ? `${base}/${layer}` : base;
}

/**
 * Partition key for ordered processing. Ordering is only guaranteed WITHIN a
 * partition; we partition by property+room+rate so two updates to the same
 * cell can never be processed out of order, while different rooms still
 * process in parallel.
 */
export function ariPartitionKey(k: Pick<AriCellKey, 'propertyId' | 'roomTypeId' | 'ratePlanId'>): string {
  return `${k.propertyId}:${k.roomTypeId}:${k.ratePlanId}`;
}

export function sha256(input: unknown): string {
  const s = typeof input === 'string' ? input : stableStringify(input);
  return createHash('sha256').update(s).digest('hex');
}

/** Deterministic JSON: key order must not change a payload hash. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as object).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`)
    .join(',')}}`;
}

/**
 * Idempotency key for an ARI mutation. Two identical payloads for the same
 * cell from the same source at the same source timestamp are the SAME event,
 * no matter how many times the transport redelivers them.
 */
export function ariIdempotencyKey(args: {
  source: string;
  key: AriCellKey;
  layer: string;
  sourceTimestamp: Date | string;
  payloadHash: string;
}): string {
  const ts =
    typeof args.sourceTimestamp === 'string'
      ? args.sourceTimestamp
      : args.sourceTimestamp.toISOString();
  return sha256(`${args.source}|${ariCellKey(args.key, args.layer)}|${ts}|${args.payloadHash}`);
}
