import { z } from 'zod';
import { NormalizedAriEvent } from './ari';

/**
 * The connectivity contract.
 *
 * This is the boundary that keeps N provider vocabularies out of the core.
 * SiteMinder, Dingus, Cloudbeds, DerbySoft and every future partner speak
 * their own dialect on one side of this interface and nothing but canonical
 * types on the other. A provider outage, a rate-limit change or a schema
 * revision is contained inside one adapter.
 */
export const ProviderSchema = z.enum([
  'MOCK_CM',
  'CANONICAL_JSON',
  'SITEMINDER',
  'DINGUS',
  'CLOUDBEDS',
  'DERBYSOFT',
]);
export type Provider = z.infer<typeof ProviderSchema>;

/**
 * Capabilities are declared PER OPERATION, never as a single "push/pull" label.
 * The audit flagged the generic label as a source of support and design errors:
 * a provider can push rates but only accept pulled restrictions.
 */
export interface AdapterCapabilities {
  discoverProperties: boolean;
  discoverRooms: boolean;
  discoverRatePlans: boolean;
  receiveAriPush: boolean;
  fetchAriPull: boolean;
  pushRate: boolean;
  pushAvailability: boolean;
  pushRestriction: boolean;
  createBooking: boolean;
  cancelBooking: boolean;
  modifyBooking: boolean;
  healthCheck: boolean;
  /** Provider guarantees a monotonic sequence per cell. When false, ordering
   *  falls back to sourceTimestamp and is best-effort — say so explicitly
   *  rather than pretending. */
  monotonicSequence: boolean;
  signatureScheme: 'NONE' | 'HMAC_SHA256' | 'MTLS' | 'BEARER';
}

/** Per-connection traffic shaping. Isolation is per connection, not per
 *  provider: one noisy hotel must not consume another hotel's budget. */
export interface RateLimitPolicy {
  requestsPerSecond: number;
  burst: number;
  maxConcurrent: number;
  /** Circuit opens after this many consecutive failures. */
  circuitFailureThreshold: number;
  circuitResetMs: number;
  retryBaseMs: number;
  retryMaxAttempts: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitPolicy = {
  requestsPerSecond: 10,
  burst: 20,
  maxConcurrent: 5,
  circuitFailureThreshold: 5,
  circuitResetMs: 30_000,
  retryBaseMs: 250,
  retryMaxAttempts: 4,
};

export interface ConnectionContext {
  connectionId: string;
  tenantId: string;
  propertyId: string;
  provider: Provider;
  /** A vault reference. Adapters receive resolved secrets from the runtime and
   *  must never log or return them. */
  credentials: Record<string, string>;
  checkpoint?: Record<string, unknown> | null;
  mappingVersion?: number | null;
  correlationId: string;
}

export interface RemoteProperty {
  remoteCode: string;
  name: string;
  city?: string;
  country?: string;
  currency?: string;
}
export interface RemoteRoom {
  remoteCode: string;
  name: string;
  maxOccupancy?: number;
}
export interface RemoteRatePlan {
  remoteCode: string;
  name: string;
  mealPlan?: string;
  currency?: string;
  roomRemoteCode?: string;
}

export interface PullWindow {
  from: string;
  to: string;
  /** Provider cursor from the previous run. Advancing it before a durable
   *  write is how backfills silently lose data. */
  cursor?: string | null;
}

export interface PullResult {
  events: NormalizedAriEvent[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface PushAriCommand {
  roomRemoteCode: string;
  ratePlanRemoteCode: string;
  stayDate: string;
  occupancy?: number;
  rate?: { currency: string; amount: number };
  availability?: number;
  restriction?: {
    open?: boolean;
    closedToArrival?: boolean;
    closedToDeparture?: boolean;
    minLos?: number;
    maxLos?: number;
  };
}

export interface SupplierBookingCommand {
  bookingReference: string;
  idempotencyKey: string;
  roomRemoteCode: string;
  ratePlanRemoteCode: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  guestName: string;
  amount: number;
  currency: string;
}

export type SupplierOutcome = 'CONFIRMED' | 'REJECTED' | 'UNKNOWN';

export interface SupplierBookingResult {
  outcome: SupplierOutcome;
  supplierReference?: string | null;
  message?: string;
  raw?: unknown;
}

export interface HealthResult {
  ok: boolean;
  latencyMs: number;
  detail: string;
  capabilities: AdapterCapabilities;
  /** Never include secrets. Certification checks this. */
  diagnostics?: Record<string, unknown>;
}

/**
 * Every adapter implements exactly this. New providers are added by writing
 * one class and passing the conformance suite — not by touching the core.
 */
export interface ChannelManagerAdapter {
  readonly provider: Provider;
  readonly capabilities: AdapterCapabilities;
  readonly rateLimit: RateLimitPolicy;

  discoverProperties(ctx: ConnectionContext): Promise<RemoteProperty[]>;
  discoverRooms(ctx: ConnectionContext): Promise<RemoteRoom[]>;
  discoverRatePlans(ctx: ConnectionContext): Promise<RemoteRatePlan[]>;

  /** Verify the provider's signature over the raw body. Returning true when
   *  the scheme is NONE must be a deliberate, documented decision. */
  verifySignature(rawBody: string, headers: Record<string, string>, secret?: string): boolean;

  /** Provider payload -> canonical events. Pure: no I/O, no side effects,
   *  so it can be unit-tested against recorded fixtures. */
  parsePush(
    payload: unknown,
    ctx: ConnectionContext,
    resolve: MappingResolver,
  ): NormalizedAriEvent[];

  fetchAri(ctx: ConnectionContext, window: PullWindow, resolve: MappingResolver): Promise<PullResult>;

  pushAri(ctx: ConnectionContext, commands: PushAriCommand[]): Promise<{ accepted: number; rejected: number; detail?: string }>;

  createBooking(ctx: ConnectionContext, cmd: SupplierBookingCommand): Promise<SupplierBookingResult>;
  cancelBooking(ctx: ConnectionContext, supplierReference: string, idempotencyKey: string): Promise<SupplierBookingResult>;
  modifyBooking(ctx: ConnectionContext, supplierReference: string, cmd: SupplierBookingCommand): Promise<SupplierBookingResult>;

  healthCheck(ctx: ConnectionContext): Promise<HealthResult>;
}

/**
 * Adapters never query the database. They receive a resolver so mapping stays
 * versioned and owned by Catalog, and so an adapter can be tested with a stub.
 */
export interface MappingResolver {
  version: number;
  roomTypeId(remoteCode: string): string | null;
  ratePlanId(remoteCode: string): string | null;
  propertyId(): string;
  tenantId(): string;
}

export interface ConnectionHealthSnapshot {
  connectionId: string;
  propertyId: string;
  propertyName: string;
  provider: Provider;
  status: string;
  mode: string;
  lastEventAt: string | null;
  lastHealthAt: string | null;
  lastHealthOk: boolean | null;
  eventsLast24h: number;
  rejectedLast24h: number;
  duplicatesLast24h: number;
  outOfOrderLast24h: number;
  p95IngestLatencyMs: number | null;
  circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  mappingVersion: number | null;
  mappingStatus: string | null;
  issues: string[];
}
