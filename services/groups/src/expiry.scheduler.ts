import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Logger } from '@wetriip/observability';
import { LOGGER } from '@wetriip/service-kit';
import { InventoryService } from './inventory.service';
import { NotificationService } from './notification.service';
import { RequestService } from './request.service';

/**
 * The clock behind the 24-hour window.
 *
 * The expiry itself is a conditional UPDATE guarded on status, so a slow tick,
 * a duplicated tick or two processes ticking at once all converge on the same
 * result. That is why this can be a plain interval rather than a lease: the
 * work is idempotent, so contention is not a correctness problem.
 */
@Injectable()
export class ExpiryScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(LOGGER) private readonly log: Logger,
    private readonly requests: RequestService,
    private readonly notifications: NotificationService,
    private readonly inventory: InventoryService,
  ) {}

  onApplicationBootstrap() {
    if (process.env.GROUPS_EXPIRY_ENABLED === 'false') {
      this.log.info('group expiry sweeper disabled');
      return;
    }
    const intervalMs = Number(process.env.GROUPS_EXPIRY_INTERVAL_MS ?? 60_000);
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.log.info('group expiry sweeper started', { intervalMs });
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const swept = await this.requests.sweep();
      if (swept.expired > 0 || swept.warned > 0) {
        this.log.info('group requests swept', swept);
      }
      // An accepted group whose rooms never left the sellable pool is the most
      // dangerous state in this domain, so the sweeper keeps trying.
      const recovered = await this.inventory.retryFailed();
      if (recovered.recovered > 0) {
        this.log.info('group inventory releases recovered', recovered);
      }

      // Draining here rather than in its own job keeps the two from disagreeing
      // about which messages exist.
      await this.notifications.dispatch();
    } catch (err) {
      // A failing sweep must not kill the interval; the next tick retries.
      this.log.warn('group expiry sweep failed', { error: String(err) });
    } finally {
      this.running = false;
    }
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }
}
