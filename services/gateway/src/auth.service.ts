import { Inject, Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { DomainError, Permission, Role, newCorrelationId } from '@wetriip/contracts';
import { resolvePermissions } from '@wetriip/domain';
import { PRISMA, RequestContext } from '@wetriip/service-kit';

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
      exp: Date.now() + 12 * 3_600_000,
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

  toContext(claims: SessionClaims, opts: { correlationId?: string; ip?: string; stepUp?: boolean } = {}): RequestContext {
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
      stepUpVerified: opts.stepUp ?? false,
    };
  }
}
