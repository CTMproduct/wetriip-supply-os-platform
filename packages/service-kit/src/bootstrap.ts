import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DEFAULT_PORTS, ServiceName } from '@wetriip/contracts';
import { Logger } from '@wetriip/observability';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { ContextGuard } from './context';
import { assertProductionPosture } from './posture';
import { DomainExceptionFilter } from './errors';

export interface BootstrapOptions {
  service: ServiceName | 'all-in-one';
  module: any;
  port?: number;
  /** Raw body is required to verify provider webhook signatures. */
  rawBodyPaths?: string[];
  cors?: boolean;
}

export async function bootstrapService(opts: BootstrapOptions): Promise<INestApplication> {
  const log = new Logger(opts.service);

  // Refuse to start rather than run a production deployment with development
  // authentication. A guard that only warns is a guard nobody reads.
  assertProductionPosture(opts.service, log);
  const app = await NestFactory.create(opts.module, {
    logger: process.env.LOG_LEVEL === 'debug' ? ['log', 'warn', 'error', 'debug'] : ['warn', 'error'],
    rawBody: true,
    bodyParser: true,
  });

  app.use(helmet({ contentSecurityPolicy: false }));
  if (opts.cors) app.enableCors({ origin: true, credentials: true });

  // ARI batches are legitimately large — a 90-day full sync for one hotel is
  // thousands of cells. Express's 100kb default is sized for form posts and
  // rejects real inventory payloads, so the limit is explicit and tunable.
  const bodyLimit = process.env.BODY_LIMIT ?? '25mb';
  app.use(json({ limit: bodyLimit }));
  app.use(urlencoded({ extended: true, limit: bodyLimit }));

  app.useGlobalFilters(new DomainExceptionFilter(log));
  app.useGlobalGuards(new ContextGuard());
  // No class-validator pipe on purpose. Validation is Zod, at the domain
  // boundary, using the same schemas the services share — one validator, one
  // source of truth, and the same rules whether a request arrives over HTTP or
  // from another service.
  app.enableShutdownHooks();

  // `Number(undefined)` is NaN, and `NaN ?? x` is NaN — so the previous
  // expression never reached its default and every service without an explicit
  // port bound to whatever NaN coerces to. Ports are also read per service, so
  // one shared PORT in .env cannot make nine services fight over 3100.
  const serviceDefault =
    opts.service === 'all-in-one' ? 3100 : DEFAULT_PORTS[opts.service as ServiceName];
  const perService = Number(
    process.env[`PORT_${opts.service.toUpperCase().replace(/-/g, '_')}`],
  );
  const generic = Number(process.env.PORT);
  const port =
    opts.port ??
    (Number.isFinite(perService)
      ? perService
      : opts.service === 'all-in-one' && Number.isFinite(generic)
        ? generic
        : serviceDefault);

  // Internal services bind to loopback unless told otherwise. Only the gateway
  // needs to be reachable from outside, and a default of 0.0.0.0 everywhere
  // meant one misconfigured ingress exposed the whole mesh.
  const host =
    process.env.BIND_HOST ??
    (opts.service === 'gateway' || opts.service === 'all-in-one' ? '0.0.0.0' : '127.0.0.1');
  await app.listen(port, host);
  log.info('service listening', {
    service: opts.service,
    port,
    host,
    busMode: process.env.BUS_MODE ?? 'outbox',
  });
  return app;
}
