import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DEFAULT_PORTS, ServiceName } from '@wetriip/contracts';
import { Logger } from '@wetriip/observability';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { ContextGuard } from './context';
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

  const port =
    opts.port ??
    Number(process.env.PORT) ??
    (opts.service === 'all-in-one' ? 3100 : DEFAULT_PORTS[opts.service as ServiceName]);

  await app.listen(port, '0.0.0.0');
  log.info('service listening', { service: opts.service, port, busMode: process.env.BUS_MODE ?? 'outbox' });
  return app;
}
