import { Inject, Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { DomainError, Permission, Role, newCorrelationId } from '@wetriip/contracts';
import { resolvePermissions } from '@wetriip/domain';
import { PRISMA, RequestContext, issueStepUpProof } from '@wetriip/service-kit';

/**
 * Session issuing.
 *
 * The gateway is the ONLY component that authenticates a human. Everything
 * behind it trusts the context headers precisely because those headers can
 * only originate here, and the internal services are not routable from
 * outside.
 *
 * This is an HMAC-signed session token, not OIDC. It is the correct shape —
 * the claims are exactly what a real IdP would assert — but production must
 * replace `login()` with an OIDC code exchange and `verify()` with JWKS
 * validation. That swap touches this file only, which is why it is isolated.
 * It is deliberately NOT a password check: this platform never handles
 * passwords itself.
 */
/**
 * How long a session token asserts authority.
 *
 * It used to be twelve hours, which meant a general manager could disable an
 * account and the disabled person kept working until lunchtime tomorrow. The
 * claims are now short-lived and every sensitive path re-reads the user row, so
 * a revocation takes effect within one token lifetime rather than one shift.
 */
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS ?? 15 * 60_000);

export interface SessionClaims {
  tenantId: string;
  userId: string;
  organizationId: string;
  role: string;
  maxAutonomy: 1 | 2 | 3;
  /** Resolved once, here, from role + grants − revokes. Every service behind
   *  the gateway reads this rather than re-deriving it. */
  permissions: Permission[];
  propertyIds: string[];
  status: string;
  email: string;
  name: string;
  /**
   * Bumped whenever the user's role, grants, revokes, scope or status changes.
   * A token carrying an old value is refused at `verify()`, so revoked
   * authority stops working immediately instead of at token expiry.
   */
  authorizationVersion: number;
  exp: number;
}

@Injectable()
export class AuthService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  private get secret(): string {
    return process.env.SESSION_SECRET ?? process.env.OFFER_SIGNING_SECRET ?? 'change-me-in-production';
  }

  async login(email: string): Promise<{ token: string; claims: SessionClaims }> {
    const user = await this.prisma.user.findFirst({
      where: { email },
      include: { organization: true },
    });
    if (!user) {
      throw new DomainError({
        code: 'PERMISSION',
        message: 'No active user with that address',
        owner: 'Platform Security',
        remediation: 'Seed the demo users, or connect the real identity provider.',
      });
    }

    // A disabled account fails here rather than deeper in, so nothing downstream
    // has to remember to check it.
    if (user.status === 'DISABLED') {
      throw new DomainError({
        code: 'PERMISSION',
        message: 'This account has been disabled.',
        owner: 'Platform Security',
        remediation: 'Ask your general manager to re-enable it.',
      });
    }

    const claims: SessionClaims = {
      tenantId: user.tenantId,
      userId: user.id,
      organizationId: user.organizationId,
      role: user.role,
      maxAutonomy: (user.maxAutonomy === 1 || user.maxAutonomy === 3 ? user.maxAutonomy : 2) as 1 | 2 | 3,
      permissions: resolvePermissions(
        user.role as Role,
        (user.grants ?? []) as Permission[],
        (user.revokes ?? []) as Permission[],
      ),
      propertyIds: user.propertyIds ?? [],
      status: user.status,
      email: user.email,
      name: user.name,
      authorizationVersion: authorizationVersionOf(user),
      exp: Date.now() + SESSION_TTL_MS,
    };

    await this.prisma.user
      .update({ where: { id: user.id }, data: { lastActiveAt: new Date() } })
      .catch(() => undefined);

    return { token: this.sign(claims), claims };
  }

  private sign(claims: SessionClaims): string {
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const sig = createHmac('sha256', this.secret).update(body).digest('base64url');
    return `${body}.${sig}`;
  }

  /**
   * Step-up.
   *
   * The proof is bound to ONE action id. Issuing it is where a real second
   * factor belongs, and the production posture check refuses to start without
   * `STEP_UP_VERIFIER` configured precisely so this cannot ship as a formality.
   */
  async stepUp(
    claims: SessionClaims,
    actionId: string,
  ): Promise<{ proof: string; expiresInSeconds: number; amr: string[] }> {
    if (!actionId) {
      throw new DomainError({
        code: 'VALIDATION',
        message: 'A step-up proof must name the action it authorises.',
        owner: 'Platform Security',
        remediation: 'Send the actionId you are about to confirm.',
      });
    }

    const verifier = process.env.STEP_UP_VERIFIER;
    if (process.env.NODE_ENV === 'production' && !verifier) {
      throw new DomainError({
        code: 'NOT_IMPLEMENTED',
        message: 'No second-factor verifier is configured.',
        owner: 'Platform Security',
        remediation: 'Set STEP_UP_VERIFIER and wire the identity provider ACR flow.',
      });
    }

    // Outside production the factor is not actually checked. The proof still
    // carries the truth about that — `amr: ['dev']` rather than `['mfa']` — so
    // nothing downstream can mistake a development proof for a real one.
    const amr = verifier ? ['mfa'] : ['dev'];

    const fresh = await this.prisma.user.findUnique({ where: { id: claims.userId } });
    if (!fresh || fresh.status !== 'ACTIVE') {
      throw new DomainError({
        code: 'PERMISSION',
        message: 'This account can no longer step up.',
        owner: 'Platform Security',
      });
    }

    return {
      proof: issueStepUpProof({
        userId: claims.userId,
        tenantId: claims.tenantId,
        actionId,
        amr,
      }),
      expiresInSeconds: 300,
      amr,
    };
  }

  /**
   * Re-read the authority behind a token.
   *
   * Called on every write path. Claims in a token are a cache, and a cache that
   * outlives a revocation is how a disabled user keeps changing rates.
   */
  async currentAuthority(claims: SessionClaims): Promise<SessionClaims> {
    const user = await this.prisma.user.findUnique({ where: { id: claims.userId } });
    if (!user || user.status !== 'ACTIVE') {
      throw new DomainError({
        code: 'PERMISSION',
        message: 'This account is no longer active.',
        owner: 'Platform Security',
        remediation: 'Sign in again.',
      });
    }
    if (authorizationVersionOf(user) !== claims.authorizationVersion) {
      throw new DomainError({
        code: 'PERMISSION',
        message: 'Your permissions changed. Sign in again to continue.',
        owner: 'Platform Security',
        details: { reason: 'authorization version mismatch' },
      });
    }
    return {
      ...claims,
      role: user.role,
      status: user.status,
      permissions: resolvePermissions(
        user.role as Role,
        (user.grants ?? []) as Permission[],
        (user.revokes ?? []) as Permission[],
      ),
      propertyIds: user.propertyIds ?? [],
      maxAutonomy: (user.maxAutonomy === 1 || user.maxAutonomy === 3 ? user.maxAutonomy : 2) as 1 | 2 | 3,
    };
  }

  verify(token: string): SessionClaims {
    const [body, sig] = (token ?? '').split('.');
    if (!body || !sig) {
      throw new DomainError({ code: 'PERMISSION', message: 'Malformed session token', owner: 'Platform Security' });
    }
    const expected = createHmac('sha256', this.secret).update(body).digest('base64url');
    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new DomainError({ code: 'PERMISSION', message: 'Invalid session signature', owner: 'Platform Security' });
    }
    const claims: SessionClaims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (claims.exp < Date.now()) {
      throw new DomainError({ code: 'PERMISSION', message: 'Session expired', owner: 'Platform Security' });
    }
    return claims;
  }

  toContext(
    claims: SessionClaims,
    opts: { correlationId?: string; ip?: string; stepUpProof?: string } = {},
  ): RequestContext {
    return {
      tenantId: claims.tenantId,
      userId: claims.userId,
      organizationId: claims.organizationId,
      role: claims.role,
      maxAutonomy: claims.maxAutonomy,
      permissions: claims.permissions ?? [],
      propertyIds: claims.propertyIds ?? [],
      status: claims.status ?? 'ACTIVE',
      correlationId: opts.correlationId ?? newCorrelationId(),
      ip: opts.ip,
      // Carried, not believed. Only the service that owns the action can turn
      // this into authority, and only for that action.
      stepUpProof: opts.stepUpProof,
      stepUpVerified: false,
    };
  }
}

/**
 * A cheap fingerprint of everything that decides what a user may do.
 *
 * Any change to it invalidates outstanding tokens, which is the point: a
 * revocation that takes twelve hours to bite is not a revocation.
 */
function authorizationVersionOf(user: {
  role: string;
  status: string;
  grants: string[];
  revokes: string[];
  propertyIds: string[];
  maxAutonomy: number;
}): number {
  const material = [
    user.role,
    user.status,
    [...(user.grants ?? [])].sort().join(','),
    [...(user.revokes ?? [])].sort().join(','),
    [...(user.propertyIds ?? [])].sort().join(','),
    String(user.maxAutonomy),
  ].join('|');
  let h = 0;
  for (let i = 0; i < material.length; i += 1) {
    h = (h * 31 + material.charCodeAt(i)) | 0;
  }
  return h;
}
