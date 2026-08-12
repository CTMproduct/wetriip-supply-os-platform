/**
 * Event catalog.
 *
 * Every cross-service fact travels as one of these. The name is the contract:
 * adding a field is allowed, changing the meaning of one is a new version.
 */
export const EVENT_TYPES = [
  // Catalog
  'PropertyCreated',
  'PropertyApproved',
  'PropertySuspended',
  'RoomMapped',
  'RatePlanMapped',
  'MappingPublished',
  'MappingRetired',

  // Connectivity
  'ConnectionActivated',
  'ConnectionPaused',
  'ConnectionHealthChanged',
  'RawARIReceived',
  'CircuitOpened',
  'CircuitClosed',

  // ARI
  'ARIValidated',
  'ARINormalized',
  'ARIRejected',
  'ARIOutOfOrder',
  'EffectiveARIChanged',

  // Commercial
  'PromotionCreated',
  'PromotionApproved',
  'PromotionPublished',
  'PromotionExpired',
  'PromotionRolledBack',
  'ContractCreated',
  'ContractPublished',
  'ContractSuspended',
  'PartnerEnabled',
  'PartnerBlocked',

  // Demand
  'SearchExecuted',
  'OfferCreated',
  'OfferExpired',

  // Booking
  'BookingRequested',
  'BookingConfirmed',
  'BookingUnknown',
  'BookingFailed',
  'BookingCancelled',

  // Reconciliation & agent
  'ReconciliationStarted',
  'ReconciliationCompleted',
  'DivergenceDetected',
  'DivergenceResolved',
  'AgentActionProposed',
  'AgentActionConfirmed',
  'AgentActionExecuted',
  'AgentActionRejected',
  'AgentActionRolledBack',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface DomainEvent<T = unknown> {
  id: string;
  type: EventType;
  tenantId: string;
  /** Ordering is only guaranteed within a partition key. */
  partitionKey: string;
  payload: T;
  correlationId: string;
  occurredAt: string;
  /** Schema version of `payload`. */
  version: number;
}

export interface EffectiveAriChangedPayload {
  propertyId: string;
  roomTypeId: string;
  ratePlanId: string;
  stayDates: string[];
  reason: 'INGEST' | 'MANAGED_OVERRIDE' | 'RECOMPUTE' | 'ROLLBACK';
}

export interface RawAriReceivedPayload {
  connectionId: string;
  envelopeId: string;
  propertyId: string;
  eventCount: number;
  payloadHash: string;
}

export interface AgentActionExecutedPayload {
  actionId: string;
  kind: string;
  userId: string;
  affectedCells: number;
  result: unknown;
}
