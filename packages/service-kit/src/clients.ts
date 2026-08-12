import { DomainError, ServiceName, serviceBaseUrl } from '@wetriip/contracts';
import { RequestContext, contextToHeaders } from './context';

/**
 * Typed inter-service client.
 *
 * Services talk over HTTP even when co-hosted, so the network contract is
 * exercised in development and in tests rather than only in production. The
 * only thing that changes between topologies is the base URL.
 *
 * Errors keep their code and correlation id across the hop: a POLICY_DENIED
 * raised in the agent service still reads as POLICY_DENIED at the gateway,
 * instead of degrading into a generic 500 one service away from the cause.
 */
export class ServiceClient {
  constructor(private readonly service: ServiceName) {}

  private url(path: string): string {
    const base = serviceBaseUrl(this.service).replace(/\/$/, '');
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    ctx: RequestContext,
    body?: unknown,
    timeoutMs = 15_000,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(this.url(path), {
        method,
        headers: {
          'content-type': 'application/json',
          ...contextToHeaders(ctx),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await res.text();
      const parsed = text ? JSON.parse(text) : null;

      if (!res.ok) {
        const e = parsed?.error;
        throw new DomainError({
          code: e?.code ?? 'DEPENDENCY_UNAVAILABLE',
          message: e?.message ?? `${this.service} responded ${res.status}`,
          owner: e?.owner,
          remediation: e?.remediation,
          details: { ...(e?.details ?? {}), service: this.service, path, status: res.status },
          correlationId: e?.correlationId ?? ctx.correlationId,
        });
      }
      return parsed as T;
    } catch (err) {
      if (err instanceof DomainError) throw err;
      throw new DomainError({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: `${this.service} is unreachable`,
        owner: 'Platform',
        remediation: `Check that ${this.service} is running and SVC_${this.service.toUpperCase().replace(/-/g, '_')}_URL is correct.`,
        details: { path, error: String(err) },
        correlationId: ctx.correlationId,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  get<T>(path: string, ctx: RequestContext) {
    return this.request<T>('GET', path, ctx);
  }
  post<T>(path: string, ctx: RequestContext, body?: unknown, timeoutMs?: number) {
    return this.request<T>('POST', path, ctx, body, timeoutMs);
  }
}

export const clients = {
  coreCommerce: new ServiceClient('core-commerce'),
  ari: new ServiceClient('ari-ingestion'),
  connectivity: new ServiceClient('connectivity'),
  search: new ServiceClient('search'),
  booking: new ServiceClient('booking'),
  agent: new ServiceClient('agent'),
  reconciliation: new ServiceClient('reconciliation'),
  groups: new ServiceClient('groups'),
};
