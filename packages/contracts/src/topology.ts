/**
 * Service topology.
 *
 * The split is drawn along FAILURE ISOLATION and SCALING CURVES, not along
 * database tables:
 *
 *  · connectivity   — N provider APIs, N failure modes, bursty, hostile.
 *                     Must never be able to take down search or booking.
 *  · ari-ingestion  — highest write throughput, partition-ordered.
 *  · search         — read-heavy, p95 < 800 ms, cache-fronted.
 *  · booking        — low volume, highest criticality, strict idempotency.
 *  · agent          — LLM latency and cost, completely different scaling curve.
 *  · core-commerce  — transactional, low volume: catalog, mapping, contracts,
 *                     promotions, identity stay together on purpose.
 *  · groups         — low volume, long-lived state, deadline-driven. Its
 *                     work is measured in hours, not milliseconds, and a
 *                     stuck negotiation must never slow a search.
 *  · reconciliation — batch, off-peak, may be slow.
 *  · gateway        — auth, routing, quotas, UI composition.
 *
 * Each is independently deployable and horizontally scalable. For laptops and
 * CI, `services/all-in-one` boots them in one process over the in-memory bus —
 * same code, same contracts, one command.
 */
export const SERVICES = [
  'gateway',
  'core-commerce',
  'connectivity',
  'ari-ingestion',
  'search',
  'booking',
  'agent',
  'groups',
  'reconciliation',
] as const;

export type ServiceName = (typeof SERVICES)[number];

export const DEFAULT_PORTS: Record<ServiceName, number> = {
  gateway: 3100,
  'core-commerce': 3110,
  connectivity: 3120,
  'ari-ingestion': 3130,
  search: 3140,
  booking: 3150,
  agent: 3160,
  reconciliation: 3170,
  groups: 3180,
};

export function serviceBaseUrl(name: ServiceName): string {
  const envKey = `SVC_${name.toUpperCase().replace(/-/g, '_')}_URL`;
  return process.env[envKey] || `http://127.0.0.1:${DEFAULT_PORTS[name]}`;
}

/** SLOs from the audit, encoded so dashboards and alerts read them from code. */
export const SLOS = {
  ariPushMaterializedSeconds: 60,
  ariPushMaterializedTarget: 0.99,
  searchAvailability: 0.9995,
  searchLatencyP95Ms: 800,
  bookingOutcomeDeterminedSeconds: 120,
  bookingOutcomeTarget: 0.999,
  duplicateBookingTolerance: 0,
} as const;
