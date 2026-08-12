/**
 * @wetriip/connectivity-sdk
 *
 * Adding a channel manager must be a one-class, one-fixture-suite job. If it
 * ever requires touching ARI, search or booking, this SDK has failed.
 *
 * Everything a provider integration is allowed to do:
 *   · translate its payloads to canonical events (parsePush / fetchAri)
 *   · translate canonical commands to its payloads (pushAri / createBooking)
 *   · declare its capabilities and its rate limits honestly
 *
 * Everything it must never do: read the database, know what a promotion is,
 * decide whether something is sellable, or log a credential.
 */
export * from './registry';
export * from './runtime';
export * from './conformance';
export * from './adapters/mock-cm.adapter';
export * from './adapters/canonical-json.adapter';
export * from './adapters/pending.adapter';
