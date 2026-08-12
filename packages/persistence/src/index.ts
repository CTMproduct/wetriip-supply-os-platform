/**
 * @wetriip/persistence
 *
 * One Postgres instance in stage 1, but STRICT table ownership: a service
 * reads and writes only its own aggregate and reaches other domains through
 * APIs and events, never through a join. That constraint is what makes the
 * later split into separate databases a configuration change instead of a
 * rewrite — and it is enforced by review, so it is written down here.
 *
 *   core-commerce   Tenant Organization User Property RoomType RatePlan
 *                   TaxRule Contract ContractVersion Promotion PromotionVersion
 *   connectivity    Connection MappingVersion MappingEntry RawEnvelope
 *   ari-ingestion   AriEvent AriCell EffectiveAri
 *   search          SearchRequest Offer
 *   booking         Booking BookingAttempt
 *   agent           AgentSession AgentAction AgentPolicy
 *   groups          GroupBlock GroupBlockLine GroupPolicy GroupRequest GroupBid
 *                   Notification EventSpace
 *   reconciliation  ReconciliationRun Divergence
 *   shared platform AuditEvent OutboxEvent  (append-only, written by all)
 */
export * from './client';
export * from './outbox';
export * from './audit';
export * from './idempotency';
export * from './decimal';
