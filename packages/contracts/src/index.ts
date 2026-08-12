/**
 * @wetriip/contracts — the only thing every service is allowed to share.
 *
 * Services do NOT share a database and do NOT import each other's code.
 * They share this package: canonical types, Zod schemas, the event catalog
 * and the typed error taxonomy. Everything crossing a service boundary is
 * validated against a schema declared here.
 */
export * from './ids';
export * from './errors';
export * from './ari';
export * from './catalog';
export * from './promotion';
export * from './commercial';
export * from './sellability';
export * from './revenue';
export * from './content';
export * from './distribution';
export * from './partner';
export * from './demand';
export * from './groups';
export * from './eventspace';
export * from './permissions';
export * from './offer';
export * from './booking';
export * from './connectivity';
export * from './agent';
export * from './events';
export * from './topology';
