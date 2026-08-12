import { ConnectionContext, DomainError, RateLimitPolicy } from '@wetriip/contracts';
import { Bulkhead, CircuitBreaker, TokenBucket, backoffMs, isRetryable } from '@wetriip/domain';
import { Logger, M, metrics } from '@wetriip/observability';

/**
 * Connection runtime.
 *
 * Every outbound call to a provider goes through here. Nothing calls a partner
 * API directly — that is the rule that keeps one slow integration from
 * becoming a platform incident.
 *
 * Order of controls, and why:
 *   1. circuit   — if we already know they are down, fail in microseconds
 *   2. bulkhead  — cap in-flight calls so a slow provider queues instead of
 *                  consuming the whole worker pool
 *   3. token bucket — respect their published rate limit; being throttled is
 *                  our fault, not theirs
 *   4. retry with full jitter — only for retryable failures, never for a 4xx
 *      that will fail identically the second time
 *
 * State is per CONNECTION, not per provider: 400 hotels on SiteMinder are 400
 * independent budgets, so one hotel's misconfiguration cannot starve the rest.
 */
export interface RuntimeState {
  bucket: TokenBucket;
  breaker: CircuitBreaker;
  bulkhead: Bulkhead;
}

export class ConnectionRuntime {
  private readonly states = new Map<string, RuntimeState>();

  constructor(private readonly log = new Logger('connectivity-runtime')) {}

  private stateFor(connectionId: string, policy: RateLimitPolicy): RuntimeState {
    let s = this.states.get(connectionId);
    if (!s) {
      s = {
        bucket: new TokenBucket(policy.requestsPerSecond, policy.burst),
        breaker: new CircuitBreaker(policy.circuitFailureThreshold, policy.circuitResetMs),
        bulkhead: new Bulkhead(policy.maxConcurrent),
      };
      this.states.set(connectionId, s);
    }
    return s;
  }

  circuitState(connectionId: string): 'CLOSED' | 'OPEN' | 'HALF_OPEN' {
    return this.states.get(connectionId)?.breaker.currentState ?? 'CLOSED';
  }

  async execute<T>(
    ctx: ConnectionContext,
    policy: RateLimitPolicy,
    operation: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const state = this.stateFor(ctx.connectionId, policy);
    const labels = { provider: ctx.provider, operation };

    if (!state.breaker.canAttempt()) {
      metrics.inc(M.connCircuitOpen, labels);
      throw new DomainError({
        code: 'CIRCUIT_OPEN',
        message: `Circuit open for connection ${ctx.connectionId}; not calling ${ctx.provider}.${operation}`,
        owner: 'Connectivity',
        remediation:
          'The provider has been failing repeatedly. Check their status page and the connection health panel; the circuit probes again automatically.',
        correlationId: ctx.correlationId,
      });
    }

    return state.bulkhead.run(async () => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= policy.retryMaxAttempts; attempt++) {
        const waitMs = state.bucket.tryAcquire();
        if (waitMs > 0) {
          metrics.inc(M.connRateLimited, labels);
          await sleep(waitMs);
          state.bucket.tryAcquire();
        }

        const started = Date.now();
        try {
          metrics.inc(M.connRequest, labels);
          const result = await fn();
          metrics.observe(M.connLatency, Date.now() - started, labels);
          state.breaker.onSuccess();
          return result;
        } catch (err) {
          lastError = err;
          metrics.observe(M.connLatency, Date.now() - started, labels);
          const status = extractStatus(err);

          if (!isRetryable(status, err)) {
            // A 4xx is a contract problem, not a transient one. Retrying it
            // burns their rate limit and hides the real error.
            state.breaker.onSuccess();
            throw wrap(err, ctx, operation, status);
          }

          state.breaker.onFailure();
          if (attempt < policy.retryMaxAttempts) {
            const delay = backoffMs(attempt, policy.retryBaseMs);
            this.log.warn('provider call failed, retrying', {
              connectionId: ctx.connectionId,
              provider: ctx.provider,
              operation,
              attempt,
              delay,
              status,
              correlationId: ctx.correlationId,
              error: String(err),
            });
            await sleep(delay);
          }
        }
      }
      throw wrap(lastError, ctx, operation, extractStatus(lastError));
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function extractStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const anyErr = err as any;
  return anyErr.status ?? anyErr.statusCode ?? anyErr.response?.status ?? null;
}

function wrap(err: unknown, ctx: ConnectionContext, operation: string, status: number | null): DomainError {
  if (err instanceof DomainError) return err;
  return new DomainError({
    code: status === 429 ? 'RATE_LIMITED' : 'DEPENDENCY_UNAVAILABLE',
    message: `${ctx.provider}.${operation} failed${status ? ` with status ${status}` : ''}`,
    owner: 'Connectivity',
    remediation: 'Inspect the connection log for the raw envelope and the provider response.',
    details: { connectionId: ctx.connectionId, provider: ctx.provider, operation, status },
    correlationId: ctx.correlationId,
  });
}
