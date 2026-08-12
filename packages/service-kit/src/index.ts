/**
 * @wetriip/service-kit
 *
 * The parts every service needs and none should reimplement: request context,
 * the error filter that turns DomainError into a typed HTTP response, the
 * health endpoint, the outbox relay and the typed clients services use to talk
 * to each other.
 */
export * from './context';
export * from './errors';
export * from './health.controller';
export * from './bootstrap';
export * from './relay';
export * from './clients';
export * from './prisma.module';
