import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { OutboxBus } from '@wetriip/bus';
import { Logger } from '@wetriip/observability';
import { EVENT_BUS, LOGGER } from './prisma.module';

/**
 * Outbox relay.
 *
 * Polls committed-but-unpublished events and delivers them to subscribers.
 * Deliberately a poller rather than a listener: polling degrades predictably
 * under load, and the backlog depth is a metric an operator can see and alert
 * on. A missed NOTIFY is invisible until someone complains.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(EVENT_BUS) private readonly bus: unknown,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  onApplicationBootstrap() {
    if (!(this.bus instanceof OutboxBus)) return; // in-memory bus needs no relay
    const intervalMs = Number(process.env.OUTBOX_POLL_MS ?? 1000);
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.log.info('outbox relay started', { intervalMs });
  }

  private async tick() {
    if (this.running || !(this.bus instanceof OutboxBus)) return;
    this.running = true;
    try {
      const n = await this.bus.relayOnce(200);
      if (n > 0) this.log.debug('outbox relayed', { delivered: n });
    } catch (err) {
      this.log.error('outbox relay failed', { error: String(err) });
    } finally {
      this.running = false;
    }
  }

  /** Tests drive the relay directly rather than waiting on a timer. */
  async drain(maxRounds = 20): Promise<number> {
    if (!(this.bus instanceof OutboxBus)) return 0;
    let total = 0;
    for (let i = 0; i < maxRounds; i++) {
      const n = await this.bus.relayOnce(500);
      total += n;
      if (n === 0) break;
    }
    return total;
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }
}
