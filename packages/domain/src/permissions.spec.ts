import {
  HOTEL_ASSIGNABLE_ROLES,
  PLATFORM_ONLY_PERMISSIONS,
  Permission,
  ROLE_PERMISSIONS,
  Role,
  StructuredCommandSchema,
} from '@wetriip/contracts';
import {
  COMMAND_PERMISSIONS,
  Principal,
  assertCan,
  assertCanAssign,
  assertNotLastAdministrator,
  can,
  canOnProperty,
  resolvePermissions,
} from './permissions';

function principal(role: Role, over: Partial<Principal> = {}): Principal {
  return {
    userId: 'u1',
    tenantId: 't1',
    organizationId: 'o1',
    role,
    permissions: resolvePermissions(role),
    propertyIds: [],
    status: 'ACTIVE',
    ...over,
  };
}

describe('permission resolution', () => {
  it('adds an explicit grant on top of the role bundle', () => {
    const perms = resolvePermissions('ECOMMERCE', ['rates.write']);
    expect(perms).toContain('rates.write');
    expect(perms).toContain('analytics.read');
  });

  it('lets revocation beat both the role and an explicit grant', () => {
    const perms = resolvePermissions('REVENUE_MANAGER', ['rates.write'], ['rates.write']);
    expect(perms).not.toContain('rates.write');
  });

  it('is stable and free of duplicates', () => {
    const perms = resolvePermissions('REVENUE_MANAGER', ['rates.write', 'rates.write']);
    expect(perms).toEqual([...new Set(perms)].sort());
  });
});

describe('the three hotel roles the extranet is built around', () => {
  it('lets the revenue manager move rates, availability and restrictions', () => {
    const rm = principal('REVENUE_MANAGER');
    for (const p of [
      'rates.write',
      'availability.write',
      'restrictions.write',
      'promotions.write',
    ] as Permission[]) {
      expect(can(rm, p)).toBe(true);
    }
  });

  it('stops the revenue manager short of user administration and contract publication', () => {
    const rm = principal('REVENUE_MANAGER');
    expect(can(rm, 'users.manage')).toBe(false);
    expect(can(rm, 'contracts.publish')).toBe(false);
  });

  it('gives e-commerce analysis and no write authority at all', () => {
    const ec = principal('ECOMMERCE');
    expect(can(ec, 'analytics.read')).toBe(true);
    expect(can(ec, 'partners.read')).toBe(true);
    const writes = resolvePermissions('ECOMMERCE').filter(
      (p) => p.endsWith('.write') || p === 'agent.execute' || p === 'users.manage',
    );
    expect(writes).toEqual([]);
  });

  it('still lets e-commerce ask the agent, which is what makes the refusal useful', () => {
    const ec = principal('ECOMMERCE');
    expect(can(ec, 'agent.use')).toBe(true);
    expect(can(ec, 'agent.execute')).toBe(false);
  });

  it('makes the general manager the person who administers people', () => {
    const gm = principal('GENERAL_MANAGER');
    expect(can(gm, 'users.manage')).toBe(true);
    expect(can(gm, 'users.read')).toBe(true);
  });

  it('keeps every hotel role blind to other tenants', () => {
    for (const role of HOTEL_ASSIGNABLE_ROLES) {
      const perms = resolvePermissions(role);
      for (const platform of PLATFORM_ONLY_PERMISSIONS) {
        expect(perms).not.toContain(platform);
      }
    }
  });
});

describe('account status', () => {
  it('empties a disabled account whatever its role says', () => {
    const gm = principal('GENERAL_MANAGER', { status: 'DISABLED' });
    expect(can(gm, 'users.manage')).toBe(false);
    expect(() => assertCan(gm, 'users.manage')).toThrow(/disabled/i);
  });

  it('refuses an invited account for a different, honest reason', () => {
    const gm = principal('GENERAL_MANAGER', { status: 'INVITED' });
    expect(() => assertCan(gm, 'users.manage')).toThrow(/activated/i);
  });
});

describe('property scope', () => {
  it('reads an empty scope as every property', () => {
    expect(canOnProperty(principal('REVENUE_MANAGER'), 'rates.write', 'any')).toBe(true);
  });

  it('refuses a scoped user on a property outside the scope', () => {
    const rm = principal('REVENUE_MANAGER', { propertyIds: ['p-ctg'] });
    expect(canOnProperty(rm, 'rates.write', 'p-ctg')).toBe(true);
    expect(canOnProperty(rm, 'rates.write', 'p-bog')).toBe(false);
    expect(() => assertCan(rm, 'rates.write', 'p-bog')).toThrow(/properties/i);
  });
});

describe('delegation limits', () => {
  it('stops a hotel administrator from minting Wetriip staff', () => {
    expect(() => assertCanAssign(principal('GENERAL_MANAGER'), 'SUPER_ADMIN', [])).toThrow(
      /only be assigned by Wetriip/i,
    );
  });

  it('stops a hotel administrator from granting a platform-only permission', () => {
    expect(() =>
      assertCanAssign(principal('GENERAL_MANAGER'), 'ECOMMERCE', ['platform.activity.read']),
    ).toThrow(/cannot be granted from inside a hotel/i);
  });

  it('never lets anyone grant authority they do not hold themselves', () => {
    const rm = principal('REVENUE_MANAGER', {
      permissions: [...resolvePermissions('REVENUE_MANAGER'), 'users.manage'],
    });
    expect(() => assertCanAssign(rm, 'ECOMMERCE', ['contracts.publish'])).toThrow(/do not hold/i);
    expect(() => assertCanAssign(rm, 'ECOMMERCE', ['rates.write'])).not.toThrow();
  });

  it('does not bind platform staff by the hotel delegation limits', () => {
    expect(() =>
      assertCanAssign(principal('SUPER_ADMIN'), 'SUPPORT', ['platform.activity.read']),
    ).not.toThrow();
  });

  it('refuses assignment outright without users.manage', () => {
    expect(() => assertCanAssign(principal('ECOMMERCE'), 'ECOMMERCE', [])).toThrow(
      /does not include/i,
    );
  });
});

describe('the last-administrator guard', () => {
  it('refuses to demote the last active administrator', () => {
    expect(() =>
      assertNotLastAdministrator({
        actorUserId: 'u1',
        targetUserId: 'u1',
        targetIsAdminNow: true,
        targetWillBeAdmin: false,
        otherActiveAdministrators: 0,
      }),
    ).toThrow(/last active administrator/i);
  });

  it('allows demotion while another administrator remains', () => {
    expect(() =>
      assertNotLastAdministrator({
        actorUserId: 'u1',
        targetUserId: 'u2',
        targetIsAdminNow: true,
        targetWillBeAdmin: false,
        otherActiveAdministrators: 1,
      }),
    ).not.toThrow();
  });
});

describe('the agent inherits authority and never grants it', () => {
  const kinds = StructuredCommandSchema.options.map(
    (o: any) => o.shape.kind.value as string,
  );

  it('maps every command kind to the permission it needs', () => {
    for (const kind of kinds) {
      expect((COMMAND_PERMISSIONS as Record<string, Permission>)[kind]).toBeDefined();
    }
    expect(Object.keys(COMMAND_PERMISSIONS)).toHaveLength(kinds.length);
  });

  it('maps only permissions some role can actually hold', () => {
    const all = new Set<Permission>();
    for (const role of Object.keys(ROLE_PERMISSIONS) as Role[]) {
      for (const p of ROLE_PERMISSIONS[role]) all.add(p);
    }
    for (const p of Object.values(COMMAND_PERMISSIONS)) {
      expect(all.has(p)).toBe(true);
    }
  });

  it('keeps an e-commerce analyst away from write commands', () => {
    const ec = principal('ECOMMERCE');
    expect(can(ec, COMMAND_PERMISSIONS.get_revenue_advisory)).toBe(true);
    expect(can(ec, COMMAND_PERMISSIONS.update_rates)).toBe(false);
    expect(can(ec, COMMAND_PERMISSIONS.create_promotion)).toBe(false);
  });
});
