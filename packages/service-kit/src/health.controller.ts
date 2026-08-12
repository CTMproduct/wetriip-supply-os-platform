import { Controller, Get } from '@nestjs/common';
import { metrics } from '@wetriip/observability';
import { getPrisma } from '@wetriip/persistence';

/**
 * Health and metrics.
 *
 * `/health/live` answers "is the process up". `/health/ready` answers "can it
 * do its job" — they are different questions and conflating them causes
 * orchestrators to restart healthy pods whose database is briefly slow.
 */
@Controller('health')
export class HealthController {
  constructor(readonly service: string) {}

  @Get('live')
  live() {
    return { status: 'ok', service: this.service, uptimeSeconds: Math.round(process.uptime()) };
  }

  @Get('ready')
  async ready() {
    const started = Date.now();
    try {
      await getPrisma().$queryRaw`SELECT 1`;
      return { status: 'ready', service: this.service, dbLatencyMs: Date.now() - started };
    } catch (err) {
      return { status: 'degraded', service: this.service, reason: String(err) };
    }
  }

  @Get('metrics')
  metricsSnapshot() {
    return metrics.snapshot();
  }
}

/** Nest needs a concrete class per service to bind the constructor argument. */
export function healthControllerFor(service: string) {
  @Controller('health')
  class ServiceHealthController extends HealthController {
    constructor() {
      super(service);
    }
  }
  return ServiceHealthController;
}
