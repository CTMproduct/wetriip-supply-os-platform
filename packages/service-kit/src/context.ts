import { CanActivate, ExecutionContext, Injectable, createParamDecorator } from '@nestjs/common';
import { DomainError, PERMISSIONS, Permission, newCorrelationId } from '@wetriip/contracts';
import {
  assertInternalSignature,
  signInternalHeaders,
  verifyInternalHeaders,
} from './internal-identity';

/**
 * Request context.
 *
 * Tenant isolation is not a filter you remember to add — it is a value that
 * accompanies every call, and a query without it is a bug the reviewer can see.
 * Correlation ids are minted at the edge and propagated so one identifier links
 * a webhook, a ledger write, a search and a booking.
 *
 * Identity is asserted by headers from the gateway — the component that
 * terminates the user's token — and those headers are SIGNED. A service that
 * receives unsigned context refuses it (see `internal-identity.ts`). Network
 * isolation remains as defence in depth; it is no longer the only defence.
 */
export interface RequestContext {
  tenantId: string;
  userId: string;
  organizationId: string;
  role: string;
  maxAutonomy: 1 | 2 | 3;
  /**
   * Resolved at the gateway from role + grants − revokes, then carried on the
   * request. Services do not re-derive it: one resolution per request means one
   * answer, and the gateway is the only place that reads the user row.
   */
  permissions: Permission[];
  /** Property scope. Empty means every property in their organization. */
  propertyIds: string[];
  status: string;
  correlationId: string;
  ip?: string;
  /**
   * A signed, action-bound step-up proof — NOT a boolean.
   *
   * The previous design transported `stepUpVerified: true`, which meant a
   * browser could type a header and unlock every HIGH-risk action on the
   * platform. Authority now travels as a proof the receiver verifies against
   * the specific action it is being used for.
   */
  stepUpProof?: string;
  /** True only once a proof has been verified against a named action. */
  stepUpVerified: boolean;
  /** Whether the internal context arrived correctly signed. */
  internallySigned?: boolean;
}

export const CTX_HEADER = {
  tenant: 'x-wetriip-tenant',
  user: 'x-wetriip-user',
  org: 'x-wetriip-org',
  role: 'x-wetriip-role',
  autonomy: 'x-wetriip-autonomy',
  correlation: 'x-correlation-id',
  stepUp: 'x-wetriip-step-up',
  stepUpProof: 'x-wetriip-step-up-proof',
  permissions: 'x-wetriip-permissions',
  properties: 'x-wetriip-properties',
  status: 'x-wetriip-status',
} as const;

/** The claim headers, in the exact shape the signature covers. */
function claimHeaders(ctx: {
  tenantId: string;
  userId: string;
  organizationId: string;
  role: string;
  maxAutonomy: number;
  permissions: readonly string[];
  propertyIds: readonly string[];
  status: string;
}): Record<string, string> {
  return {
    [CTX_HEADER.tenant]: ctx.tenantId,
    [CTX_HEADER.user]: ctx.userId,
    [CTX_HEADER.org]: ctx.organizationId,
    [CTX_HEADER.role]: ctx.role,
    [CTX_HEADER.autonomy]: String(ctx.maxAutonomy),
    [CTX_HEADER.permissions]: (ctx.permissions ?? []).join(','),
    [CTX_HEADER.properties]: (ctx.propertyIds ?? []).join(','),
    [CTX_HEADER.status]: ctx.status ?? 'ACTIVE',
  };
}

/** Map the wire header names onto the short keys the signature canonicaliser
 *  uses, so both sides agree without repeating the string literals. */
function signatureClaims(c: Record<string, string>): Record<string, string> {
  return {
    tenant: c[CTX_HEADER.tenant] ?? '',
    user: c[CTX_HEADER.user] ?? '',
    org: c[CTX_HEADER.org] ?? '',
    role: c[CTX_HEADER.role] ?? '',
    autonomy: c[CTX_HEADER.autonomy] ?? '',
    permissions: c[CTX_HEADER.permissions] ?? '',
    properties: c[CTX_HEADER.properties] ?? '',
    status: c[CTX_HEADER.status] ?? '',
  };
}

export function contextFromHeaders(headers: Record<string, any>, ip?: string): RequestContext {
  const h = (k: string) => {
    const v = headers[k] ?? headers[k.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  const tenantId = h(CTX_HEADER.tenant);
  if (!tenantId) {
    throw new DomainError({
      code: 'PERMISSION',
      message: 'Missing tenant context',
      owner: 'Platform Security',
      remediation: `Send ${CTX_HEADER.tenant}; the gateway derives it from the verified token.`,
    });
  }
  const autonomy = Number(h(CTX_HEADER.autonomy) ?? 2);
  const list = (raw: unknown): string[] =>
    String(raw ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);

  // Verify the signature over exactly the claims that arrived — not over what
  // we would have liked them to be. Defaults applied before verification would
  // let a caller omit a header and have us sign our own guess.
  const presented = {
    [CTX_HEADER.tenant]: String(tenantId),
    [CTX_HEADER.user]: String(h(CTX_HEADER.user) ?? ''),
    [CTX_HEADER.org]: String(h(CTX_HEADER.org) ?? ''),
    [CTX_HEADER.role]: String(h(CTX_HEADER.role) ?? ''),
    [CTX_HEADER.autonomy]: String(h(CTX_HEADER.autonomy) ?? ''),
    [CTX_HEADER.permissions]: String(h(CTX_HEADER.permissions) ?? ''),
    [CTX_HEADER.properties]: String(h(CTX_HEADER.properties) ?? ''),
    [CTX_HEADER.status]: String(h(CTX_HEADER.status) ?? ''),
  };
  const verification = verifyInternalHeaders(headers, signatureClaims(presented));
  assertInternalSignature(verification);

  return {
    tenantId,
    userId: h(CTX_HEADER.user) ?? 'anonymous',
    organizationId: h(CTX_HEADER.org) ?? '',
    role: h(CTX_HEADER.role) ?? 'SUPPORT',
    maxAutonomy: (autonomy === 1 || autonomy === 2 || autonomy === 3 ? autonomy : 2) as 1 | 2 | 3,
    permissions: list(h(CTX_HEADER.permissions)) as Permission[],
    propertyIds: list(h(CTX_HEADER.properties)),
    status: h(CTX_HEADER.status) ?? 'ACTIVE',
    correlationId: h(CTX_HEADER.correlation) ?? newCorrelationId(),
    ip,
    // Carried, never trusted. It becomes authority only when a service verifies
    // it against the specific action being confirmed.
    stepUpProof: h(CTX_HEADER.stepUpProof),
    stepUpVerified: false,
    internallySigned: verification.signed,
  };
}

export function contextToHeaders(ctx: RequestContext): Record<string, string> {
  const claims = claimHeaders(ctx);
  return {
    ...claims,
    ...signInternalHeaders(signatureClaims(claims)),
    [CTX_HEADER.correlation]: ctx.correlationId,
    // The proof travels as an opaque token. Whoever consumes it verifies it
    // against the action; nobody downstream can promote it to a boolean.
    ...(ctx.stepUpProof ? { [CTX_HEADER.stepUpProof]: ctx.stepUpProof } : {}),
  };
}

/**
 * A machine identity: the webhook receiver, the pull scheduler, reconciliation.
 *
 * These act as the platform rather than as a person, so they carry the full
 * permission set — but they are constructed HERE, in one place, so a new
 * context field can never be forgotten in one caller and silently change what
 * a background job is allowed to do.
 */
export function systemContext(args: {
  tenantId: string;
  actor: string;
  correlationId: string;
}): RequestContext {
  return {
    tenantId: args.tenantId,
    userId: `system:${args.actor}`,
    organizationId: '',
    role: 'SUPER_ADMIN',
    maxAutonomy: 3,
    permissions: [...PERMISSIONS] as Permission[],
    propertyIds: [],
    status: 'ACTIVE',
    correlationId: args.correlationId,
    stepUpVerified: false,
    internallySigned: true,
  };
}

export const Ctx = createParamDecorator((_data: unknown, exec: ExecutionContext): RequestContext => {
  const req = exec.switchToHttp().getRequest();
  if (!req.wetriipContext) {
    req.wetriipContext = contextFromHeaders(req.headers, req.ip);
  }
  return req.wetriipContext;
});

/**
 * Populates the request context when the headers are present. It does NOT
 * enforce.
 *
 * Enforcement belongs to whoever actually needs identity: `@Ctx()` throws on a
 * missing tenant, the gateway verifies its own session token, and webhooks
 * authenticate with a provider signature instead of a user token. A guard that
 * rejected everything without a tenant header would also reject the login
 * endpoint that issues the token in the first place.
 */
@Injectable()
export class ContextGuard implements CanActivate {
  canActivate(exec: ExecutionContext): boolean {
    const req = exec.switchToHttp().getRequest();
    try {
      req.wetriipContext = contextFromHeaders(req.headers, req.ip);
    } catch {
      req.wetriipContext = undefined;
    }
    return true;
  }
}
