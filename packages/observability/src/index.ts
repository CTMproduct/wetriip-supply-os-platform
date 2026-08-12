/**
 * Observability.
 *
 * Four layers, straight from the audit, because each answers a different
 * question and mixing them is how incidents take hours instead of minutes:
 *
 *   CONNECTION — can we talk to the partner at all?
 *   INGESTION  — what did we receive, and what did we accept?
 *   EFFECTIVE  — what ended up sellable?
 *   COMMERCIAL — what did the buyer search and buy?
 *
 * Every log line and every metric carries a correlationId, so one identifier
 * follows a change from the channel manager's webhook to the buyer's search.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  correlationId?: string;
  tenantId?: string;
  propertyId?: string;
  connectionId?: string;
  service?: string;
  [k: string]: unknown;
}

/** Never let a secret reach a log. Enforced here rather than trusted to callers. */
const REDACT_KEYS = /(password|secret|token|apikey|api_key|authorization|credential|bearer)/i;

export function redact<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT_KEYS.test(k) ? '[redacted]' : redact(v);
  }
  return out as T;
}

export class Logger {
  constructor(
    private readonly service: string,
    private readonly base: LogFields = {},
  ) {}

  child(fields: LogFields): Logger {
    return new Logger(this.service, { ...this.base, ...fields });
  }

  private emit(level: LogLevel, message: string, fields: LogFields = {}) {
    const line = {
      ts: new Date().toISOString(),
      level,
      service: this.service,
      message,
      ...redact({ ...this.base, ...fields }),
    };
    const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    out.write(`${JSON.stringify(line)}\n`);
  }

  debug(m: string, f?: LogFields) {
    if (process.env.LOG_LEVEL === 'debug') this.emit('debug', m, f);
  }
  info(m: string, f?: LogFields) {
    this.emit('info', m, f);
  }
  warn(m: string, f?: LogFields) {
    this.emit('warn', m, f);
  }
  error(m: string, f?: LogFields) {
    this.emit('error', m, f);
  }
}

export interface MetricSnapshot {
  counters: Record<string, number>;
  histograms: Record<string, { count: number; p50: number; p95: number; p99: number; max: number }>;
  gauges: Record<string, number>;
}

/**
 * In-process metrics with a bounded reservoir. Deliberately simple: this is a
 * seam for Prometheus/OTel, not a replacement for it. Percentiles matter more
 * than averages for latency and gaps, so histograms report p50/p95/p99.
 */
export class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private samples = new Map<string, number[]>();
  private static readonly MAX_SAMPLES = 2048;

  private key(name: string, labels?: Record<string, string>): string {
    if (!labels || Object.keys(labels).length === 0) return name;
    const l = Object.keys(labels)
      .sort()
      .map((k) => `${k}=${labels[k]}`)
      .join(',');
    return `${name}{${l}}`;
  }

  inc(name: string, labels?: Record<string, string>, by = 1): void {
    const k = this.key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }

  gauge(name: string, value: number, labels?: Record<string, string>): void {
    this.gauges.set(this.key(name, labels), value);
  }

  observe(name: string, value: number, labels?: Record<string, string>): void {
    const k = this.key(name, labels);
    const arr = this.samples.get(k) ?? [];
    arr.push(value);
    if (arr.length > Metrics.MAX_SAMPLES) arr.shift();
    this.samples.set(k, arr);
  }

  async time<T>(name: string, fn: () => Promise<T>, labels?: Record<string, string>): Promise<T> {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      this.observe(name, Date.now() - start, labels);
    }
  }

  snapshot(): MetricSnapshot {
    const histograms: MetricSnapshot['histograms'] = {};
    for (const [k, arr] of this.samples) {
      const s = [...arr].sort((a, b) => a - b);
      const at = (p: number) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
      histograms[k] = { count: s.length, p50: at(50), p95: at(95), p99: at(99), max: s[s.length - 1] ?? 0 };
    }
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms,
    };
  }
}

export const metrics = new Metrics();

/** Canonical metric names. Typos in metric names are invisible failures. */
export const M = {
  // connection
  connAuthSuccess: 'connectivity.auth.success',
  connRequest: 'connectivity.request',
  connLatency: 'connectivity.latency_ms',
  connCircuitOpen: 'connectivity.circuit.open',
  connRateLimited: 'connectivity.rate_limited',
  // ingestion
  ariReceived: 'ari.events.received',
  ariAccepted: 'ari.events.accepted',
  ariRejected: 'ari.events.rejected',
  ariDuplicate: 'ari.events.duplicate',
  ariOutOfOrder: 'ari.events.out_of_order',
  ariIngestLatency: 'ari.ingest.latency_ms',
  ariMaterializeLatency: 'ari.materialize.latency_ms',
  // effective
  effectiveStale: 'effective.stale_cells',
  effectiveSellable: 'effective.sellable_ratio',
  // commercial
  searchLatency: 'search.latency_ms',
  searchOffers: 'search.offers',
  searchExcluded: 'search.excluded',
  bookingRequested: 'booking.requested',
  bookingConfirmed: 'booking.confirmed',
  bookingUnknown: 'booking.unknown',
  bookingFailed: 'booking.failed',
  // agent
  agentProposed: 'agent.action.proposed',
  agentExecuted: 'agent.action.executed',
  agentDenied: 'agent.action.denied',
  agentLlmLatency: 'agent.llm.latency_ms',
} as const;
