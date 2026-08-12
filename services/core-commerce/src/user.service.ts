import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import {
  DomainError,
  HOTEL_ASSIGNABLE_ROLES,
  PERMISSION_LABELS,
  Permission,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  ResolvedUser,
  Role,
  UpsertUserSchema,
} from '@wetriip/contracts';
import {
  Principal,
  assertCan,
  assertCanAssign,
  assertNotLastAdministrator,
  resolvePermissions,
} from '@wetriip/domain';
import { AuditLog } from '@wetriip/persistence';
import { AUDIT_LOG, PRISMA, RequestContext } from '@wetriip/service-kit';

/**
 * User administration.
 *
 * The general manager runs their own team: who gets in, what they may do, which
 * properties they may touch. Wetriip staff can do the same across every tenant,
 * and everything either of them does lands in the audit ledger.
 *
 * Two safety rails that matter more than the CRUD:
 *  · nobody can grant authority they do not hold themselves
 *  · the last active administrator cannot be disabled or demoted
 */
@Injectable()
export class UserService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
  ) {}

  private principal(ctx: RequestContext): Principal {
    return {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
      role: ctx.role as Role,
      permissions: ctx.permissions,
      propertyIds: ctx.propertyIds,
      status: ctx.status,
    };
  }

  private isPlatformStaff(ctx: RequestContext): boolean {
    return ctx.role === 'SUPER_ADMIN' || ctx.role === 'SUPPORT';
  }

  /** The catalog a manager sees before assigning anything, so a role is a
   *  visible list of capabilities rather than a word they have to trust. */
  catalog(ctx: RequestContext) {
    const assignable: Role[] = this.isPlatformStaff(ctx)
      ? (Object.keys(ROLE_PERMISSIONS) as Role[])
      : HOTEL_ASSIGNABLE_ROLES;

    return {
      // Every role is described, including ones this person may not assign —
      // an owner still appears in their team list and must not render as a
      // raw enum. `assignable` is what narrows the picker.
      roles: (Object.keys(ROLE_PERMISSIONS) as Role[]).map((role) => ({
        role,
        label: ROLE_LABELS[role],
        description: ROLE_DESCRIPTIONS[role],
        permissions: ROLE_PERMISSIONS[role],
        assignable: assignable.includes(role),
      })),
      permissions: Object.entries(PERMISSION_LABELS).map(([key, label]) => ({
        permission: key as Permission,
        label,
        /** A hotel administrator cannot hand out what they do not hold. */
        grantable: this.isPlatformStaff(ctx) || ctx.permissions.includes(key as Permission),
      })),
    };
  }

  async list(ctx: RequestContext, organizationId?: string): Promise<ResolvedUser[]> {
    assertCan(this.principal(ctx), 'users.read');

    // A hotel administrator sees their own organization. Wetriip staff may look
    // at any of them, which is the point of platform administration.
    const scope = this.isPlatformStaff(ctx)
      ? organizationId
        ? { organizationId }
        : {}
      : { organizationId: ctx.organizationId };

    const rows = await this.prisma.user.findMany({
      where: { tenantId: ctx.tenantId, ...scope },
      include: { organization: true },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    });
    return rows.map(toResolved);
  }

  async get(ctx: RequestContext, userId: string): Promise<ResolvedUser> {
    const row = await this.prisma.user.findFirst({
      where: { id: userId, tenantId: ctx.tenantId },
      include: { organization: true },
    });
    if (!row) {
      throw new DomainError({ code: 'NOT_FOUND', message: 'User not found', owner: 'Platform Security' });
    }
    // Reading yourself never needs a permission; reading anyone else does.
    if (row.id !== ctx.userId) assertCan(this.principal(ctx), 'users.read');
    return toResolved(row);
  }

  async upsert(
    ctx: RequestContext,
    input: unknown,
    organizationId?: string,
  ): Promise<ResolvedUser> {
    const actor = this.principal(ctx);
    const u = UpsertUserSchema.parse(input);

    const targetOrgId = this.isPlatformStaff(ctx)
      ? (organizationId ?? ctx.organizationId)
      : ctx.organizationId;

    assertCanAssign(actor, u.role, u.grants);

    const org = await this.prisma.organization.findFirst({
      where: { id: targetOrgId, tenantId: ctx.tenantId },
    });
    if (!org) {
      throw new DomainError({
        code: 'NOT_FOUND',
        message: 'Organization not found',
        owner: 'Platform Security',
      });
    }

    // A scope that names properties belonging to somebody else is a mistake we
    // refuse rather than silently ignore.
    if (u.propertyIds.length) {
      const owned = await this.prisma.property.findMany({
        where: { id: { in: u.propertyIds }, tenantId: ctx.tenantId, organizationId: targetOrgId },
        select: { id: true },
      });
      const missing = u.propertyIds.filter((id) => !owned.some((o) => o.id === id));
      if (missing.length) {
        throw new DomainError({
          code: 'VALIDATION',
          message: `These properties do not belong to this organization: ${missing.join(', ')}`,
          owner: 'Platform Security',
          details: { missing },
        });
      }
    }

    const existing = await this.prisma.user.findFirst({
      where: { tenantId: ctx.tenantId, email: u.email },
    });

    if (existing && existing.organizationId !== targetOrgId) {
      throw new DomainError({
        code: 'CONFLICT',
        message: 'That email already belongs to a user in another organization',
        owner: 'Platform Security',
        remediation: 'Use a different address, or move the existing user first.',
      });
    }

    if (existing) {
      await this.guardLastAdministrator(ctx, existing, u.role, u.status);
    }

    const row = await this.prisma.user.upsert({
      where: { tenantId_email: { tenantId: ctx.tenantId, email: u.email } },
      create: {
        tenantId: ctx.tenantId,
        organizationId: targetOrgId,
        email: u.email,
        name: u.name,
        jobTitle: u.jobTitle ?? null,
        role: u.role,
        status: u.status,
        active: u.status !== 'DISABLED',
        grants: u.grants,
        revokes: u.revokes,
        propertyIds: u.propertyIds,
        maxAutonomy: u.maxAutonomy,
        invitedBy: ctx.userId,
      },
      update: {
        name: u.name,
        jobTitle: u.jobTitle ?? null,
        role: u.role,
        status: u.status,
        active: u.status !== 'DISABLED',
        grants: u.grants,
        revokes: u.revokes,
        propertyIds: u.propertyIds,
        maxAutonomy: u.maxAutonomy,
        disabledAt: u.status === 'DISABLED' ? new Date() : null,
        disabledBy: u.status === 'DISABLED' ? ctx.userId : null,
      },
      include: { organization: true },
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorType: 'USER',
      actorId: ctx.userId,
      action: existing ? 'user.updated' : 'user.invited',
      resourceType: 'User',
      resourceId: row.id,
      before: existing
        ? {
            role: existing.role,
            status: existing.status,
            grants: existing.grants,
            revokes: existing.revokes,
            propertyIds: existing.propertyIds,
            maxAutonomy: existing.maxAutonomy,
          }
        : null,
      after: {
        role: u.role,
        status: u.status,
        grants: u.grants,
        revokes: u.revokes,
        propertyIds: u.propertyIds,
        maxAutonomy: u.maxAutonomy,
      },
      correlationId: ctx.correlationId,
      ip: ctx.ip,
    });

    return toResolved(row);
  }

  async setStatus(
    ctx: RequestContext,
    userId: string,
    status: 'ACTIVE' | 'DISABLED',
    reason?: string,
  ): Promise<ResolvedUser> {
    assertCan(this.principal(ctx), 'users.manage');

    const target = await this.prisma.user.findFirst({
      where: { id: userId, tenantId: ctx.tenantId },
      include: { organization: true },
    });
    if (!target) {
      throw new DomainError({ code: 'NOT_FOUND', message: 'User not found', owner: 'Platform Security' });
    }
    if (!this.isPlatformStaff(ctx) && target.organizationId !== ctx.organizationId) {
      throw new DomainError({
        code: 'PERMISSION',
        message: 'You can only manage users in your own organization',
        owner: 'Platform Security',
      });
    }
    if (target.id === ctx.userId && status === 'DISABLED') {
      throw new DomainError({
        code: 'CONFLICT',
        message: 'You cannot disable your own account',
        owner: 'Platform Security',
        remediation: 'Ask another administrator to do it.',
      });
    }

    await this.guardLastAdministrator(ctx, target, target.role as Role, status);

    const row = await this.prisma.user.update({
      where: { id: userId },
      data: {
        status,
        active: status === 'ACTIVE',
        disabledAt: status === 'DISABLED' ? new Date() : null,
        disabledBy: status === 'DISABLED' ? ctx.userId : null,
      },
      include: { organization: true },
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorType: 'USER',
      actorId: ctx.userId,
      action: status === 'ACTIVE' ? 'user.enabled' : 'user.disabled',
      resourceType: 'User',
      resourceId: userId,
      before: { status: target.status },
      after: { status },
      reason: reason ?? null,
      correlationId: ctx.correlationId,
      ip: ctx.ip,
    });

    return toResolved(row);
  }

  /**
   * A hotel locked out of its own extranet is a support incident nobody can
   * resolve from inside, so the last active administrator cannot be removed.
   */
  private async guardLastAdministrator(
    ctx: RequestContext,
    target: { id: string; role: string; status: string; organizationId: string },
    nextRole: Role,
    nextStatus: string,
  ): Promise<void> {
    const isAdminRole = (r: string) => ROLE_PERMISSIONS[r as Role]?.includes('users.manage');
    const wasAdmin = isAdminRole(target.role) && target.status === 'ACTIVE';
    const willBeAdmin = isAdminRole(nextRole) && nextStatus === 'ACTIVE';
    if (!wasAdmin || willBeAdmin) return;

    const peers = await this.prisma.user.findMany({
      where: {
        tenantId: ctx.tenantId,
        organizationId: target.organizationId,
        status: 'ACTIVE',
        NOT: { id: target.id },
      },
      select: { role: true },
    });

    assertNotLastAdministrator({
      actorUserId: ctx.userId,
      targetUserId: target.id,
      targetIsAdminNow: true,
      targetWillBeAdmin: false,
      otherActiveAdministrators: peers.filter((p) => isAdminRole(p.role)).length,
    });
  }

  /**
   * Resolution used by the gateway on every request. Kept here, next to the
   * write path, so the rule that resolves a permission and the rule that
   * assigns it cannot drift apart.
   */
  async resolveForSession(tenantId: string, email: string) {
    const row = await this.prisma.user.findFirst({
      where: { tenantId, email },
      include: { organization: true },
    });
    return row ? toResolved(row) : null;
  }

  async touchLastActive(userId: string): Promise<void> {
    await this.prisma.user
      .update({ where: { id: userId }, data: { lastActiveAt: new Date() } })
      .catch(() => undefined);
  }
}

function toResolved(row: any): ResolvedUser {
  const grants = (row.grants ?? []) as Permission[];
  const revokes = (row.revokes ?? []) as Permission[];
  return {
    id: row.id,
    tenantId: row.tenantId,
    organizationId: row.organizationId,
    organizationName: row.organization?.name ?? row.organizationId,
    email: row.email,
    name: row.name,
    jobTitle: row.jobTitle ?? null,
    role: row.role,
    status: row.status,
    maxAutonomy: (row.maxAutonomy === 1 || row.maxAutonomy === 3 ? row.maxAutonomy : 2) as 1 | 2 | 3,
    propertyIds: row.propertyIds ?? [],
    permissions: resolvePermissions(row.role, grants, revokes),
    grants,
    revokes,
    lastActiveAt: row.lastActiveAt?.toISOString() ?? null,
    invitedBy: row.invitedBy ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
