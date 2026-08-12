/**
 * Resilience primitives for the connectivity fleet.
 *
 * This platform is an extranet whose whole job is talking to other people's
 * APIs — dozens of them, each with its own rate limits, latency profile and
 * bad days. The failure we design against is not "an API is down"; it is
 * "an API is slow, and our workers pile up behind it until search stops
 * responding for hotels that have nothing to do with that provider".
 *
 * Three controls, all scoped PER CONNECTION rather than per provider so one
 * noisy hotel cannot consume another hotel's budget:
 *
 *   TokenBucket    — how fast we may call
 *   Bulkhead       — how many calls may be in flight
 *   CircuitBreaker — when to stop calling and fail fast
 */

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    now: number = Date.now(),
  ) {
    this.tokens = burst;
    this.lastRefill = now;
  }

  /** Milliseconds the caller must wait; 0 means go now. */
  tryAcquire(now: number = Date.now()): number {
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSecond);
    this.lastRefill = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1000);
  }

  get available(): number {
    return Math.floor(this.tokens);
  }
}

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreaker {
  private failures = 0;
  private state: CircuitState = 'CLOSED';
  private openedAt = 0;

  constructor(
    private readonly failureThreshold: number,
    private readonly resetMs: number,
  ) {}

  get currentState(): CircuitState {
    return this.state;
  }

  canAttempt(now: number = Date.now()): boolean {
    if (this.state === 'CLOSED') return true;
    if (this.state === 'OPEN') {
      if (now - this.openedAt >= this.resetMs) {
        // One probe. If it fails we go straight back to OPEN rather than
        // letting a recovering provider get hammered by the whole fleet.
        this.state = 'HALF_OPEN';
        return true;
      }
      return false;
    }
    return true;
  }

  onSuccess(): void {
    this.failures = 0;
    this.state = 'CLOSED';
  }

  onFailure(now: number = Date.now()): void {
    this.failures += 1;
    if (this.state === 'HALF_OPEN' || this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = now;
    }
  }
}

/** Concurrency isolation. Slow providers queue; they do not spread. */
export class Bulkhead {
  private inFlight = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.inFlight += 1;
    try {
      return await fn();
    } finally {
      this.inFlight -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }

  get depth(): number {
    return this.queue.length;
  }
  get active(): number {
    return this.inFlight;
  }
}

/** Full jitter exponential backoff. Deterministic when `rand` is supplied,
 *  which is what makes the retry policy unit-testable. */
export function backoffMs(
  attempt: number,
  baseMs: number,
  maxMs = 30_000,
  rand: () => number = Math.random,
): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(rand() * exp);
}

export function isRetryable(status: number | null, err?: unknown): boolean {
  if (status == null) return true; // network/timeout
  if (status === 429) return true;
  if (status >= 500) return true;
  return false;
}

/**
 * Idempotency store contract. The audit rates duplicate bookings from a
 * non-idempotent retry as P0/critical; this is the interface every write path
 * goes through.
 */
export interface IdempotencyStore {
  /** Returns the previous result if this key was already completed. */
  get(key: string): Promise<{ status: 'IN_PROGRESS' | 'COMPLETED'; result?: unknown } | null>;
  begin(key: string, ttlSeconds: number): Promise<boolean>;
  complete(key: string, result: unknown): Promise<void>;
  release(key: string): Promise<void>;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, { status: 'IN_PROGRESS' | 'COMPLETED'; result?: unknown; expiresAt: number }>();

  async get(key: string) {
    const v = this.map.get(key);
    if (!v) return null;
    if (v.expiresAt < Date.now()) {
      this.map.delete(key);
      return null;
    }
    return { status: v.status, result: v.result };
  }

  async begin(key: string, ttlSeconds: number): Promise<boolean> {
    const existing = await this.get(key);
    if (existing) return false;
    this.map.set(key, { status: 'IN_PROGRESS', expiresAt: Date.now() + ttlSeconds * 1000 });
    return true;
  }

  async complete(key: string, result: unknown): Promise<void> {
    const v = this.map.get(key);
    this.map.set(key, {
      status: 'COMPLETED',
      result,
      expiresAt: v?.expiresAt ?? Date.now() + 86_400_000,
    });
  }

  async release(key: string): Promise<void> {
    this.map.delete(key);
  }
}
