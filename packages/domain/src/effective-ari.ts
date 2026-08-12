import {
  AriLayer,
  AriValues,
  EffectiveAriRow,
  FieldProvenance,
  StayDate,
} from '@wetriip/contracts';

/**
 * Effective ARI Engine.
 *
 * External + Managed -> Effective. Deterministic, explainable, and it never
 * writes back into either source layer.
 *
 * Precedence rule: a MANAGED value wins field-by-field, but only while its
 * validity window covers the stay date. When the override expires the External
 * value re-emerges on its own — no cleanup job, no drift.
 *
 * Contract and promotion adjustments are deliberately absent: they belong to
 * offer construction. Writing a buyer-specific discount into the inventory
 * ledger is how platforms lose the ability to answer "what did the hotel
 * actually send us?".
 */

export interface LayerInput {
  layer: AriLayer;
  values: AriValues;
  source: string;
  sourceTimestamp: Date;
  version: number;
  /** MANAGED only. Absent means "always". */
  validFrom?: Date | null;
  validTo?: Date | null;
}

export interface ComputeEffectiveArgs {
  key: {
    tenantId: string;
    propertyId: string;
    roomTypeId: string;
    ratePlanId: string;
    stayDate: StayDate;
    occupancy: number;
  };
  external?: LayerInput | null;
  managed?: LayerInput | null;
  now: Date;
  freshnessSlaSeconds: number;
}

const NUMERIC_DEFAULTS = {
  available: 0,
  minLos: 1,
  releaseDays: 0,
  bookingGap: 0,
} as const;

function withinValidity(l: LayerInput, stayDate: StayDate): boolean {
  if (l.layer !== 'MANAGED') return true;
  const d = new Date(`${stayDate}T00:00:00.000Z`).getTime();
  if (l.validFrom && d < l.validFrom.getTime()) return false;
  if (l.validTo && d > l.validTo.getTime()) return false;
  return true;
}

export function computeEffectiveAri(args: ComputeEffectiveArgs): EffectiveAriRow {
  const { key, now, freshnessSlaSeconds } = args;
  const notes: string[] = [];
  const fields: Record<string, FieldProvenance> = {};
  const layersPresent: AriLayer[] = [];

  // Ordered lowest-precedence first; later layers overwrite earlier ones.
  const stack: LayerInput[] = [];
  if (args.external) {
    stack.push(args.external);
    layersPresent.push('EXTERNAL');
  }
  if (args.managed) {
    layersPresent.push('MANAGED');
    if (withinValidity(args.managed, key.stayDate)) {
      stack.push(args.managed);
    } else {
      notes.push(
        `Managed override present but outside its validity window for ${key.stayDate}; external value stands.`,
      );
    }
  }

  const merged: Partial<AriValues> = {};
  for (const layer of stack) {
    for (const [field, value] of Object.entries(layer.values)) {
      // undefined = "not mentioned". null = "explicitly cleared".
      if (value === undefined) continue;
      (merged as any)[field] = value;
      fields[field] = {
        layer: layer.layer,
        source: layer.source,
        sourceTimestamp: layer.sourceTimestamp.toISOString(),
      };
    }
  }

  // Freshness is measured against the EXTERNAL source only. A human override
  // does not make a dead channel-manager feed look alive — that mistake would
  // hide the exact failure the operator needs to see.
  const externalTs = args.external?.sourceTimestamp ?? null;
  const freshnessSeconds = externalTs
    ? Math.max(0, Math.round((now.getTime() - externalTs.getTime()) / 1000))
    : Number.MAX_SAFE_INTEGER;
  const stale = !externalTs || freshnessSeconds > freshnessSlaSeconds;
  if (!externalTs) notes.push('No external ARI has ever been received for this cell.');
  else if (stale)
    notes.push(
      `External ARI is ${freshnessSeconds}s old, beyond the ${freshnessSlaSeconds}s SLA.`,
    );

  // stopSell is a veto, never merely a hint: open=true with stopSell=true is
  // closed. Providers send both and disagree with themselves regularly.
  const rawOpen = merged.open ?? false;
  const stopSell = merged.stopSell ?? false;
  const open = Boolean(rawOpen) && !stopSell;
  if (rawOpen && stopSell) {
    notes.push('Cell reports open=true and stopSell=true; stop-sell wins.');
  }

  const available = merged.available ?? merged.allotment ?? NUMERIC_DEFAULTS.available;

  return {
    tenantId: key.tenantId,
    propertyId: key.propertyId,
    roomTypeId: key.roomTypeId,
    ratePlanId: key.ratePlanId,
    stayDate: key.stayDate,
    occupancy: key.occupancy,

    currency: merged.currency ?? null,
    baseAmount: merged.baseAmount ?? null,
    available: Math.max(0, available ?? 0),
    open,
    closedToArrival: merged.closedToArrival ?? false,
    closedToDeparture: merged.closedToDeparture ?? false,
    minLos: merged.minLos ?? NUMERIC_DEFAULTS.minLos,
    maxLos: merged.maxLos ?? null,
    releaseDays: merged.releaseDays ?? NUMERIC_DEFAULTS.releaseDays,
    bookingGap: merged.bookingGap ?? NUMERIC_DEFAULTS.bookingGap,

    freshnessSeconds: externalTs ? freshnessSeconds : -1,
    stale,

    explanation: { fields, layersPresent, notes },

    externalVersion: args.external?.version ?? 0,
    managedVersion: args.managed?.version ?? 0,
    version: (args.external?.version ?? 0) + (args.managed?.version ?? 0),
    computedAt: now.toISOString(),
  };
}

/**
 * Apply a partial update to a layer's stored values.
 * `undefined` leaves a field alone; `null` clears it. A channel manager sending
 * only a price must not blank out the availability it never mentioned.
 */
export function mergeLayerValues(current: AriValues, incoming: AriValues): AriValues {
  const out: AriValues = { ...current };
  for (const [field, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    (out as any)[field] = value;
  }
  return out;
}
