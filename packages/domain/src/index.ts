/**
 * @wetriip/domain — every deterministic decision the platform makes.
 *
 * Nothing in this package does I/O. No database, no HTTP, no clock other than
 * the one it is handed. That is deliberate: these are the engines an auditor,
 * a hotel or a court might one day ask us to explain, so they must be
 * reproducible from their inputs alone.
 *
 * It is also why the LLM can be wrong without being dangerous — the model
 * proposes a StructuredCommand, and everything that decides what actually
 * happens lives here.
 */
export * from './ordering';
export * from './effective-ari';
export * from './sellability';
export * from './promotions';
export * from './fx';
export * from './pricing';
export * from './offer-signature';
export * from './policy';
export * from './simulation';
export * from './intent-grammar';
export * from './diagnostics';
export * from './revenue';
export * from './content';
export * from './distribution';
export * from './demand';
export * from './groups';
export * from './eventspace';
export * from './permissions';
export * from './resilience';
