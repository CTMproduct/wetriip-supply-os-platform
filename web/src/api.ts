/**
 * Console API client.
 *
 * Every failure carries the platform's typed error code, so the UI can say WHY
 * a screen is empty. "No data" and "no permission" and "filtered out" look
 * identical otherwise, and the audit named that ambiguity as a real
 * operational cost.
 */
const BASE = import.meta.env.VITE_API_BASE ?? '';

export interface ApiError {
  code: string;
  message: string;
  owner?: string;
  remediation?: string;
  details?: Record<string, unknown>;
  correlationId?: string;
}

export class ApiFailure extends Error {
  constructor(readonly error: ApiError) {
    super(error.message);
  }
}

let token: string | null = localStorage.getItem('wt_token');

/**
 * The step-up proof for the ONE action being confirmed.
 *
 * It used to be `stepUp = true`, sent as a header — a boolean the browser
 * asserted about itself, which unlocked every high-risk action on the platform.
 * It is now a signed, short-lived token the server issues per action and
 * verifies against that action, and it is cleared the moment it is used.
 */
let stepUpProof: string | null = null;

export function setToken(t: string | null) {
  token = t;
  if (t) localStorage.setItem('wt_token', t);
  else localStorage.removeItem('wt_token');
  // Whoever is arriving or leaving, the previous session's cached rates,
  // partners and bookings go with them. One person's data must not survive
  // into another person's console.
  clearCache();
}
export function getToken() {
  return token;
}
export function setStepUpProof(proof: string | null) {
  stepUpProof = proof;
}

/**
 * Last-known-good cache.
 *
 * The console is an extranet a hotel works in all day, and the platform behind
 * it is eight services with eight independent failure modes. When one of them
 * is unreachable, showing yesterday's numbers WITH THEIR AGE beats showing an
 * error wall: a revenue manager can still read what the rate was, and can see
 * at a glance that they are not looking at something live.
 *
 * Only GETs are cached, and a stale answer is always tagged. A stale WRITE is
 * never invented — an action that did not reach the server must fail loudly.
 */
const CACHE_PREFIX = 'wt_cache:';
const CACHE_TTL_MS = 12 * 3_600_000;

/**
 * Paths that must NEVER be answered from cache.
 *
 * Identity is the obvious one and the reason this list exists: a cached
 * `/api/v1/me` meant that when the platform was unreachable the console would
 * render you as whoever signed in last — with THEIR permissions deciding which
 * screens you get. Signing in as somebody else and landing in the previous
 * user's console is not a degraded experience, it is the wrong answer.
 *
 * Stale rates are useful. A stale identity is a lie.
 */
const NEVER_CACHED = ['/api/v1/me', '/api/v1/users', '/api/v1/admin/'];

function cacheable(path: string): boolean {
  return !NEVER_CACHED.some((p) => path.startsWith(p));
}

export interface Staleness {
  stale: boolean;
  fetchedAt: number | null;
  reason: string | null;
}

const staleness = new Map<string, Staleness>();

export function stalenessOf(path: string): Staleness | null {
  return staleness.get(path) ?? null;
}

function readCache<T>(path: string): { value: T; fetchedAt: number } | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + path);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { value: T; fetchedAt: number };
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(path: string, value: unknown) {
  try {
    localStorage.setItem(CACHE_PREFIX + path, JSON.stringify({ value, fetchedAt: Date.now() }));
  } catch {
    // A full quota must never break the page it was trying to help.
  }
}

export function clearCache() {
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
  }
  staleness.clear();
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(stepUpProof ? { 'x-wetriip-step-up': stepUpProof } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // The request never left the browser: no server, no network, no DNS.
    throw new ApiFailure({
      code: 'DEPENDENCY_UNAVAILABLE',
      message: 'The platform is not responding.',
      owner: 'Platform',
      remediation: 'Check that the API is running (npm run dev) and reachable from this browser.',
    });
  }

  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // A dev-server proxy, a load balancer or a crash page answers in HTML.
    // Parsing it as JSON used to throw a raw SyntaxError at the caller, which
    // told the operator nothing about what had actually happened.
    parsed = null;
  }

  if (!res.ok) {
    // A platform error always carries `error`. Its ABSENCE means the response
    // did not come from the platform at all — the proxy could not reach it.
    // "Request failed (500)" is a status code, not a cause, and sending an
    // operator to look for a bug in the login when the API is simply down is
    // the most expensive kind of unhelpful.
    if (parsed?.error) throw new ApiFailure(parsed.error);
    throw new ApiFailure(
      res.status >= 500
        ? {
            code: 'DEPENDENCY_UNAVAILABLE',
            message: 'The platform is not responding.',
            owner: 'Platform',
            remediation:
              `The request to ${path} came back ${res.status} with no platform error attached, ` +
              'which usually means the API is not running behind this address. Start it with npm run dev.',
          }
        : {
            code: 'INTERNAL',
            message: `The platform answered ${res.status} without explaining why.`,
            owner: 'Platform',
            remediation: `Path: ${path}. Check the service logs for this request.`,
          },
    );
  }
  return parsed as T;
}

/**
 * A GET that survives the back end.
 *
 * A 4xx is the server answering — no permission, not found — and must reach the
 * caller unchanged. Only a transport failure or a 5xx falls back to cache,
 * because only those mean "we could not ask", not "the answer is no".
 */
async function get<T>(path: string): Promise<T> {
  try {
    const value = await request<T>('GET', path);
    if (cacheable(path)) writeCache(path, value);
    staleness.set(path, { stale: false, fetchedAt: Date.now(), reason: null });
    return value;
  } catch (err) {
    // Identity and access-control reads fail loudly. There is no acceptable
    // stale answer to "who am I" or "who may do what".
    if (!cacheable(path)) throw err;

    const transport = !(err instanceof ApiFailure);
    const serverFault =
      err instanceof ApiFailure &&
      ['INTERNAL', 'DEPENDENCY_UNAVAILABLE', 'CIRCUIT_OPEN', 'RATE_LIMITED'].includes(
        err.error.code,
      );
    if (!transport && !serverFault) throw err;

    const cached = readCache<T>(path);
    if (!cached) throw err;

    staleness.set(path, {
      stale: true,
      fetchedAt: cached.fetchedAt,
      reason: err instanceof ApiFailure ? err.error.message : 'The platform is unreachable.',
    });
    return cached.value;
  }
}

export const api = {
  posture: () => request<any>('GET', '/api/v1/auth/posture'),
  login: (email: string) => request<any>('POST', '/api/v1/auth/login', { email }),
  me: () => get<any>('/api/v1/me'),
  overview: () => get<any>('/api/v1/overview'),
  properties: () => get<any[]>('/api/v1/properties'),
  workspace: (id: string) => get<any>(`/api/v1/properties/${id}/workspace`),
  calendar: (id: string, from: string, to: string) =>
    get<any[]>(`/api/v1/properties/${id}/calendar?from=${from}&to=${to}`),
  ledger: (id: string, limit = 60) =>
    get<any[]>(`/api/v1/properties/${id}/ledger?limit=${limit}`),
  diagnose: (id: string) => get<any>(`/api/v1/properties/${id}/diagnose`),

  content: (id: string, locale = 'es') =>
    get<any>(`/api/v1/properties/${id}/content?locale=${locale}`),
  updateContent: (id: string, body: unknown) =>
    request<any>('POST', `/api/v1/properties/${id}/content`, body),
  contentSources: (id: string) =>
    get<any[]>(`/api/v1/properties/${id}/content/sources`),
  distributionPolicy: (id: string) =>
    get<any>(`/api/v1/properties/${id}/distribution`),
  setDistribution: (id: string, body: unknown) =>
    request<any>('POST', `/api/v1/properties/${id}/distribution`, body),
  distributionReach: (id: string) =>
    get<any>(`/api/v1/properties/${id}/distribution/reach`),
  propertyDemand: (id: string, days = 30) =>
    get<any>(`/api/v1/properties/${id}/demand?days=${days}`),
  travelFlow: (direction: string, anchor: string, days = 30) =>
    get<any>(`/api/v1/travel-flow?direction=${direction}&anchor=${anchor}&days=${days}`),
  partnerDirectory: () => get<any[]>('/api/v1/partners'),
  partnerCredit: (organizationId: string) =>
    get<any[]>(`/api/v1/partners/${organizationId}/credit`),
  approve: (id: string) => request<any>('POST', `/api/v1/properties/${id}/approve`, {}),

  connectivityHealth: (propertyId?: string) =>
    get<any[]>(`/api/v1/connectivity/health${propertyId ? `?propertyId=${propertyId}` : ''}`),
  providers: () => get<any[]>('/api/v1/connectivity/providers'),
  conformance: (provider: string) =>
    request<any>('POST', `/api/v1/connectivity/providers/${provider}/conformance`),
  pull: (connectionId: string) =>
    request<any>('POST', `/api/v1/connectivity/connections/${connectionId}/pull`, {}),
  connHealthCheck: (connectionId: string) =>
    request<any>('POST', `/api/v1/connectivity/connections/${connectionId}/health-check`, {}),

  promotions: (propertyId: string) =>
    get<any[]>(`/api/v1/promotions?propertyId=${propertyId}`),
  contracts: () => get<any[]>('/api/v1/contracts'),
  bookings: (propertyId?: string) =>
    get<any[]>(`/api/v1/bookings${propertyId ? `?propertyId=${propertyId}` : ''}`),

  agentCapabilities: () => get<any>('/api/v1/agent/capabilities'),
  chatSessions: () => get<any[]>('/api/v1/agent/chat/sessions'),
  chatThread: (id: string) => get<any[]>(`/api/v1/agent/chat/sessions/${id}`),
  revenue: (propertyId: string) =>
    get<any>(`/api/v1/properties/${propertyId}/revenue`),
  partners: (propertyId: string) =>
    get<any[]>(`/api/v1/properties/${propertyId}/partners`),
  ask: (body: unknown) => request<any>('POST', '/api/v1/agent/ask', body),
  /** Ask for a proof bound to this action, then confirm with it and drop it. */
  stepUp: (actionId: string) =>
    request<{ proof: string; expiresInSeconds: number; amr: string[] }>(
      'POST',
      '/api/v1/auth/step-up',
      { actionId },
    ),
  confirm: async (id: string, withStepUp = false) => {
    if (withStepUp) {
      const { proof } = await api.stepUp(id);
      setStepUpProof(proof);
    }
    try {
      return await request<any>('POST', `/api/v1/agent/actions/${id}/confirm`, {});
    } finally {
      setStepUpProof(null);
    }
  },
  reject: (id: string, reason: string) =>
    request<any>('POST', `/api/v1/agent/actions/${id}/reject`, { reason }),
  rollback: (id: string, reason: string) =>
    request<any>('POST', `/api/v1/agent/actions/${id}/rollback`, { reason }),
  actions: (limit = 50) => get<any[]>(`/api/v1/agent/actions?limit=${limit}`),

  groupBlocks: (propertyId?: string) =>
    get<any[]>(`/api/v1/groups/blocks${propertyId ? `?propertyId=${propertyId}` : ''}`),
  upsertGroupBlock: (body: unknown) => request<any>('POST', '/api/v1/groups/blocks', body),
  groupPolicy: (propertyId: string) => get<any>(`/api/v1/groups/policy/${propertyId}`),
  setGroupPolicy: (body: unknown) => request<any>('POST', '/api/v1/groups/policy', body),
  groupRequests: (propertyId?: string) =>
    get<any[]>(`/api/v1/groups/requests${propertyId ? `?propertyId=${propertyId}` : ''}`),
  groupRequest: (id: string) => get<any>(`/api/v1/groups/requests/${id}`),
  createGroupRequest: (body: unknown) => request<any>('POST', '/api/v1/groups/requests', body),
  respondGroupRequest: (body: unknown) =>
    request<any>('POST', '/api/v1/groups/requests/respond', body),
  withdrawGroupRequest: (id: string, reason?: string) =>
    request<any>('POST', `/api/v1/groups/requests/${id}/withdraw`, { reason }),
  releaseGroupInventory: (id: string) =>
    request<any>('POST', `/api/v1/groups/requests/${id}/release-inventory`, {}),
  groupNotifications: (requestId?: string) =>
    get<any[]>(`/api/v1/groups/notifications${requestId ? `?requestId=${requestId}` : ''}`),
  notificationCapabilities: () => get<any[]>('/api/v1/groups/notifications/capabilities'),

  eventSpaces: (propertyId?: string) =>
    get<any[]>(`/api/v1/event-spaces${propertyId ? `?propertyId=${propertyId}` : ''}`),
  upsertEventSpace: (body: unknown) => request<any>('POST', '/api/v1/event-spaces', body),
  quoteEventSpace: (body: unknown) => request<any>('POST', '/api/v1/event-spaces/quote', body),

  userCatalog: () => get<any>('/api/v1/users/catalog'),
  users: () => get<any[]>('/api/v1/users'),
  upsertUser: (body: unknown) => request<any>('POST', '/api/v1/users', body),
  setUserStatus: (id: string, status: 'ACTIVE' | 'DISABLED', reason?: string) =>
    request<any>('POST', `/api/v1/users/${id}/status`, { status, reason }),

  adminTenants: () => get<any[]>('/api/v1/admin/tenants'),
  adminUsers: () => get<any[]>('/api/v1/admin/users'),
  adminActivity: (limit = 120) =>
    get<any[]>(`/api/v1/admin/activity?limit=${limit}`),

  reconcile: (propertyId: string) =>
    request<any>('POST', '/api/v1/reconciliation/run', { propertyId }),
  reconRuns: () => get<any[]>('/api/v1/reconciliation/runs'),
  audit: (limit = 80) => get<any[]>(`/api/v1/audit?limit=${limit}`),
};

export const iso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (n: number) => iso(new Date(Date.now() + n * 86400000));

export function money(amount: number | null | undefined, currency: string): string {
  if (amount == null) return '—';
  const zeroDecimal = ['COP', 'CLP', 'JPY', 'KRW'].includes(currency);
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency,
    maximumFractionDigits: zeroDecimal ? 0 : 2,
  }).format(amount);
}

export function relativeAge(seconds: number | null): string {
  if (seconds == null || seconds < 0) return 'never';
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}
