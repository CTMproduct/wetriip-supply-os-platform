import {
  CommandKind,
  DomainError,
  PLATFORM_ONLY_PERMISSIONS,
  Permission,
  ROLE_PERMISSIONS,
  Role,
} from '@wetriip/contracts';

/**
 * Permission resolution.
 *
 * Pure, so "can this person do this?" is answerable in a unit test rather than
 * by clicking through the console with five different logins.
 *
 * Precedence is fixed and deliberate:
 *
 *   role bundle  +  explicit grants  −  explicit revokes
 *
 * Revocation is last and unconditional. A general manager who takes something
 * away from one person must not find the role quietly handing it back — that is
 * the single most surprising thing a permission system can do.
 */
export function resolvePermissions(
  role: Role,
  grants: Permission[] = [],
  revokes: Permission[] = [],
): Permission[] {
  const set = new Set<Permission>(ROLE_PERMISSIONS[role] ?? []);
  for (const g of grants) set.add(g);
  for (const r of revokes) set.delete(r);
  return [...set].sort();
}

export interface Principal {
  userId: string;
  tenantId: string;
  organizationId: string;
  role: Role;
  permissions: Permission[];
  /** Empty means every property in their organization. */
  propertyIds: string[];
  status: string;
}

export function can(principal: Principal, permission: Permission): boolean {
  if (principal.status !== 'ACTIVE') return false;
  return principal.permissions.includes(permission);
}

/**
 * Property scoping is separate from permission on purpose. WHAT you may do is a
 * permission; WHICH properties you may do it to is a scope. Folding scope into
 * roles produces a role per property, which nobody can reason about.
 */
export function canOnProperty(
  principal: Principal,
  permission: Permission,
  propertyId: string,
): boolean {
  if (!can(principal, permission)) return false;
  if (principal.propertyIds.length === 0) return true;
  return principal.propertyIds.includes(propertyId);
}

export function assertCan(
  principal: Principal,
  permission: Permission,
  propertyId?: string,
): void {
  if (principal.status === 'DISABLED') {
    throw new DomainError({
      code: 'PERMISSION',
      message: 'This account is disabled.',
      owner: 'Platform Security',
      remediation: 'Ask your general manager to re-enable it.',
    });
  }
  if (principal.status === 'INVITED') {
    throw new DomainError({
      code: 'PERMISSION',
      message: 'This account has not been activated yet.',
      owner: 'Platform Security',
      remediation: 'Accept the invitation before using the extranet.',
    });
  }

  if (!can(principal, permission)) {
    throw new DomainError({
      code: 'PERMISSION',
      message: `Your role (${principal.role}) does not include ${permission}.`,
      owner: 'Platform Security',
      remediation:
        'A general manager can grant this permission individually without changing your role.',
      details: { permission, role: principal.role },
    });
  }

  if (propertyId && !canOnProperty(principal, permission, propertyId)) {
    throw new DomainError({
      code: 'PERMISSION',
      message: 'Your access is limited to specific properties, and this is not one of them.',
      owner: 'Platform Security',
      remediation: 'Ask your general manager to widen your property scope.',
      details: { propertyId, scopedTo: principal.propertyIds },
    });
  }
}

/**
 * Which permission each agent command needs.
 *
 * This is what keeps the assistant honest: an e-commerce analyst can ask it to
 * raise rates, the model will happily build the command, and it will be refused
 * here — with the reason — because that person has no `rates.write`. The agent
 * inherits the caller's permissions; it never carries its own.
 */
export const COMMAND_PERMISSIONS: Record<CommandKind, Permission> = {
  explain_no_sales: 'analytics.read',
  get_availability: 'rates.read',
  get_ari_health: 'connectivity.read',
  get_connectivity_health: 'connectivity.read',
  list_promotions: 'promotions.read',
  get_revenue_advisory: 'analytics.read',
  get_partner_production: 'analytics.read',
  create_promotion: 'promotions.write',
  update_promotion: 'promotions.write',
  set_promotion_status: 'promotions.write',
  update_rates: 'rates.write',
  update_availability: 'availability.write',
  update_restriction: 'restrictions.write',
  list_group_requests: 'groups.read',
  get_event_spaces: 'events.read',
  set_group_policy: 'groups.write',
  upsert_event_space: 'events.write',
  respond_group_request: 'groups.negotiate',
  rollback_action: 'agent.rollback',
};

/**
 * What a hotel administrator is allowed to hand out.
 *
 * A GM can tailor their own team, but cannot mint Wetriip staff, cannot grant a
 * platform permission, and cannot promote someone past their own authority.
 * Without this a single compromised GM account owns the whole platform.
 */
export function assertCanAssign(
  actor: Principal,
  targetRole: Role,
  grants: Permission[],
): void {
  assertCan(actor, 'users.manage');

  const isPlatformStaff = actor.role === 'SUPER_ADMIN' || actor.role === 'SUPPORT';

  if (!isPlatformStaff) {
    if (targetRole === 'SUPER_ADMIN' || targetRole === 'SUPPORT') {
      throw new DomainError({
        code: 'PERMISSION',
        message: 'Wetriip staff roles can only be assigned by Wetriip.',
        owner: 'Platform Security',
        details: { targetRole },
      });
    }

    const forbidden = grants.filter((g) => PLATFORM_ONLY_PERMISSIONS.includes(g));
    if (forbidden.length) {
      throw new DomainError({
        code: 'PERMISSION',
        message: `These permissions cannot be granted from inside a hotel: ${forbidden.join(', ')}.`,
        owner: 'Platform Security',
        details: { forbidden },
      });
    }

    // Nobody hands out authority they do not hold. Otherwise a revenue manager
    // with users.manage could grant themselves contract publication.
    const beyond = grants.filter((g) => !actor.permissions.includes(g));
    if (beyond.length) {
      throw new DomainError({
        code: 'PERMISSION',
        message: `You cannot grant permissions you do not hold yourself: ${beyond.join(', ')}.`,
        owner: 'Platform Security',
        remediation: 'Ask Wetriip, or a colleague who holds them, to make this change.',
        details: { beyond },
      });
    }
  }
}

/** A person must not be able to disable or demote themselves out of the last
 *  administrator seat — a hotel locked out of its own extranet is a support
 *  incident nobody can resolve from inside. */
export function assertNotLastAdministrator(args: {
  actorUserId: string;
  targetUserId: string;
  targetIsAdminNow: boolean;
  targetWillBeAdmin: boolean;
  otherActiveAdministrators: number;
}): void {
  if (!args.targetIsAdminNow || args.targetWillBeAdmin) return;
  if (args.otherActiveAdministrators > 0) return;

  throw new DomainError({
    code: 'CONFLICT',
    message: 'This is the last active administrator for this organization.',
    owner: 'Platform Security',
    remediation:
      'Promote someone else to general manager first. A hotel with no administrator cannot manage its own access.',
  });
}

export const ADMIN_PERMISSION: Permission = 'users.manage';
