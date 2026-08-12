import { z } from 'zod';

/**
 * Permissions.
 *
 * A hotel is not one person. The revenue manager moves rates, the e-commerce
 * analyst reads data and spots opportunities, the general manager decides who
 * gets to do what. Modelling that as a single "hotel user" role is how a
 * platform ends up with everyone sharing one login.
 *
 * Three layers, in order of precedence:
 *
 *   1. ROLE      a named bundle of permissions — the sensible default
 *   2. GRANTS    extra permissions this specific person was given
 *   3. REVOKES   permissions taken away from this specific person
 *
 * Revocation beats a grant, and a grant beats the role. A general manager who
 * takes something away must not find the role handing it back.
 *
 * Scope is separate from permission: WHAT you may do is a permission, WHICH
 * properties you may do it to is `propertyIds`. Conflating them produces a
 * combinatorial explosion of roles nobody can reason about.
 */

export const PERMISSIONS = [
  // ── Read ──────────────────────────────────────────────
  'property.read',
  'content.read',
  'rates.read',
  'promotions.read',
  'contracts.read',
  'distribution.read',
  'connectivity.read',
  'groups.read',
  'events.read',
  'bookings.read',
  'partners.read',
  'analytics.read',
  'audit.read',
  'users.read',

  // ── Write ─────────────────────────────────────────────
  'property.write',
  'property.approve',
  'content.write',
  'rates.write',
  'availability.write',
  'restrictions.write',
  'promotions.write',
  'contracts.write',
  'contracts.publish',
  'distribution.write',
  'connectivity.manage',
  'connectivity.sync',
  'groups.write',
  'groups.negotiate',
  'events.write',
  'bookings.cancel',
  'partners.write',
  'partners.credit',
  'users.manage',

  // ── Agent ─────────────────────────────────────────────
  /** May open the Command Center and ask questions. */
  'agent.use',
  /** May confirm a proposed change. Without it the agent can only propose. */
  'agent.execute',
  /** May undo an executed action. */
  'agent.rollback',

  // ── Platform (Wetriip staff only) ─────────────────────
  'platform.tenants.read',
  'platform.activity.read',
  'platform.impersonate.read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const RoleSchema = z.enum([
  // Hotel side
  'GENERAL_MANAGER',
  'REVENUE_MANAGER',
  'ECOMMERCE',
  'RESERVATION_AGENT',
  'FINANCE',
  'CONNECTIVITY_ADMIN',
  'HOTEL_OWNER',
  // Buyer side
  'AGENCY_ADMIN',
  // Wetriip staff
  'SUPPORT',
  'SUPER_ADMIN',
]);
export type Role = z.infer<typeof RoleSchema>;

const READ_ONLY: Permission[] = [
  'property.read',
  'content.read',
  'rates.read',
  'promotions.read',
  'contracts.read',
  'distribution.read',
  'connectivity.read',
  'groups.read',
  'events.read',
  'bookings.read',
  'analytics.read',
];

/**
 * Role bundles.
 *
 * Written as what each person actually does in a hotel, not as an abstract
 * hierarchy. The e-commerce analyst is the interesting one: they can use the
 * agent and therefore PROPOSE changes, but without `agent.execute` somebody
 * else confirms. That is exactly how the job works — they find the
 * opportunity, revenue or the GM signs it off.
 */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  /** The hotel's own administrator. Owns who else gets in. */
  GENERAL_MANAGER: [
    ...READ_ONLY,
    'audit.read',
    'users.read',
    'users.manage',
    'property.write',
    'content.write',
    'rates.write',
    'availability.write',
    'restrictions.write',
    'promotions.write',
    'contracts.write',
    'contracts.publish',
    'distribution.write',
    'connectivity.manage',
    'connectivity.sync',
    'groups.write',
    'groups.negotiate',
    'events.write',
    'bookings.cancel',
    'partners.read',
    'agent.use',
    'agent.execute',
    'agent.rollback',
  ],

  /** Same authority as the GM over commerce, minus the ability to change who
   *  else has access. Separating those two is the whole point of the model. */
  HOTEL_OWNER: [
    ...READ_ONLY,
    'audit.read',
    'users.read',
    'users.manage',
    'property.write',
    'property.approve',
    'content.write',
    'rates.write',
    'availability.write',
    'restrictions.write',
    'promotions.write',
    'contracts.write',
    'contracts.publish',
    'distribution.write',
    'connectivity.manage',
    'connectivity.sync',
    'groups.write',
    'groups.negotiate',
    'events.write',
    'bookings.cancel',
    'partners.read',
    'agent.use',
    'agent.execute',
    'agent.rollback',
  ],

  /** Broad commercial freedom: rates, inventory, restrictions, promotions,
   *  distribution. No user administration, and cannot publish a contract —
   *  that is a commitment the business signs, not a pricing decision. */
  REVENUE_MANAGER: [
    ...READ_ONLY,
    'audit.read',
    'content.write',
    'rates.write',
    'availability.write',
    'restrictions.write',
    'promotions.write',
    'distribution.write',
    'connectivity.sync',
    'groups.write',
    'groups.negotiate',
    'events.write',
    'partners.read',
    'agent.use',
    'agent.execute',
    'agent.rollback',
  ],

  /** Analysis and opportunity spotting. Reads everything commercial, changes
   *  nothing directly — but may use the agent, so the opportunities they find
   *  arrive as proposals somebody with authority confirms. */
  ECOMMERCE: [...READ_ONLY, 'partners.read', 'agent.use'],

  RESERVATION_AGENT: [
    'property.read',
    'content.read',
    'rates.read',
    'promotions.read',
    'groups.read',
    'events.read',
    'bookings.read',
    'bookings.cancel',
    'availability.write',
    'agent.use',
  ],

  FINANCE: [
    'property.read',
    'bookings.read',
    'contracts.read',
    'partners.read',
    'partners.credit',
    'analytics.read',
    'audit.read',
    'agent.use',
  ],

  CONNECTIVITY_ADMIN: [
    'property.read',
    'content.read',
    'rates.read',
    'connectivity.read',
    'connectivity.manage',
    'connectivity.sync',
    'audit.read',
    'agent.use',
  ],

  /** A buyer, not hotel staff. Sees what it is entitled to buy. */
  AGENCY_ADMIN: [
    'property.read',
    'content.read',
    'rates.read',
    'promotions.read',
    'bookings.read',
    'groups.read',
    'events.read',
    /** The buyer side of the negotiation: raise a request, counter, withdraw.
     *  It never reaches the hotel's own accept path — that is enforced by
     *  organization, not only by permission. */
    'groups.negotiate',
    'agent.use',
  ],

  /** Wetriip staff. Reads everything, changes nothing. */
  SUPPORT: [
    ...READ_ONLY,
    'audit.read',
    'users.read',
    'partners.read',
    'platform.tenants.read',
    'platform.activity.read',
    'platform.impersonate.read',
    'agent.use',
  ],

  /** Wetriip platform administrator. Everything, everywhere. */
  SUPER_ADMIN: [...PERMISSIONS],
};

/** Roles a hotel's own administrator may assign. They cannot mint Wetriip
 *  staff, and they cannot grant a role above their own. */
export const HOTEL_ASSIGNABLE_ROLES: Role[] = [
  'GENERAL_MANAGER',
  'REVENUE_MANAGER',
  'ECOMMERCE',
  'RESERVATION_AGENT',
  'FINANCE',
  'CONNECTIVITY_ADMIN',
];

export const PLATFORM_ROLES: Role[] = ['SUPPORT', 'SUPER_ADMIN'];

/** Permissions a hotel administrator may never hand out, whatever they type. */
export const PLATFORM_ONLY_PERMISSIONS: Permission[] = [
  'platform.tenants.read',
  'platform.activity.read',
  'platform.impersonate.read',
  'property.approve',
];

export const UserStatusSchema = z.enum(['INVITED', 'ACTIVE', 'DISABLED']);
export type UserStatus = z.infer<typeof UserStatusSchema>;

export const UpsertUserSchema = z
  .object({
    email: z.string().email(),
    name: z.string().min(2).max(160),
    role: RoleSchema,
    jobTitle: z.string().max(120).nullish(),
    /** Empty means every property in their organization. */
    propertyIds: z.array(z.string()).default([]),
    grants: z.array(z.enum(PERMISSIONS)).default([]),
    revokes: z.array(z.enum(PERMISSIONS)).default([]),
    maxAutonomy: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
    status: UserStatusSchema.default('INVITED'),
  })
  .strict()
  .superRefine((u, ctx) => {
    const overlap = u.grants.filter((g) => u.revokes.includes(g));
    if (overlap.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['revokes'],
        message: `Granted and revoked at the same time: ${overlap.join(', ')}. Revocation would win; remove the grant to say so plainly.`,
      });
    }
  });
export type UpsertUserInput = z.infer<typeof UpsertUserSchema>;

export interface ResolvedUser {
  id: string;
  tenantId: string;
  organizationId: string;
  organizationName: string;
  email: string;
  name: string;
  jobTitle: string | null;
  role: Role;
  status: UserStatus;
  maxAutonomy: 1 | 2 | 3;
  propertyIds: string[];
  /** Everything they can do, after role + grants − revokes. */
  permissions: Permission[];
  /** Beyond the role bundle. */
  grants: Permission[];
  /** Taken away from the role bundle. */
  revokes: Permission[];
  lastActiveAt: string | null;
  invitedBy: string | null;
  createdAt: string;
}

/** Shown in the console so a manager can see what a role means before they
 *  assign it, rather than discovering it from a support ticket. */
export const PERMISSION_LABELS: Record<Permission, string> = {
  'property.read': 'View properties',
  'content.read': 'View hotel profile',
  'rates.read': 'View rates and availability',
  'promotions.read': 'View promotions',
  'contracts.read': 'View contracts',
  'distribution.read': 'View distribution rules',
  'connectivity.read': 'View connections',
  'bookings.read': 'View bookings',
  'partners.read': 'View partners',
  'analytics.read': 'View revenue and demand analytics',
  'audit.read': 'View the audit trail',
  'users.read': 'View users',
  'property.write': 'Edit property details',
  'property.approve': 'Approve a property',
  'content.write': 'Edit hotel profile and photos',
  'rates.write': 'Change rates',
  'availability.write': 'Change availability',
  'restrictions.write': 'Change stay restrictions',
  'promotions.write': 'Create and edit promotions',
  'contracts.write': 'Draft contracts',
  'contracts.publish': 'Publish contracts',
  'distribution.write': 'Change who can see this hotel',
  'groups.read': 'View group blocks and requests',
  'events.read': 'View event spaces',
  'groups.write': 'Load group inventory and benefits',
  'groups.negotiate': 'Accept, counter or decline a group offer',
  'events.write': 'Configure event spaces and pricing',
  'connectivity.manage': 'Manage channel manager connections',
  'connectivity.sync': 'Refresh inventory from the channel manager',
  'bookings.cancel': 'Cancel bookings',
  'partners.write': 'Edit partner profiles',
  'partners.credit': 'Move partner credit lines',
  'users.manage': 'Add, disable and permission users',
  'agent.use': 'Use the AI Command Center',
  'agent.execute': 'Confirm changes the agent proposes',
  'agent.rollback': 'Undo executed actions',
  'platform.tenants.read': 'Wetriip: see all tenants',
  'platform.activity.read': 'Wetriip: see all activity',
  'platform.impersonate.read': 'Wetriip: read any tenant data',
};

export const ROLE_LABELS: Record<Role, string> = {
  GENERAL_MANAGER: 'Gerente general',
  HOTEL_OWNER: 'Propietario',
  REVENUE_MANAGER: 'Revenue manager',
  ECOMMERCE: 'E-commerce',
  RESERVATION_AGENT: 'Reservas',
  FINANCE: 'Finanzas',
  CONNECTIVITY_ADMIN: 'Conectividad',
  AGENCY_ADMIN: 'Agencia',
  SUPPORT: 'Wetriip Support',
  SUPER_ADMIN: 'Wetriip Admin',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  GENERAL_MANAGER:
    'Administra el hotel y a su equipo: habilita usuarios, otorga permisos y tiene autoridad comercial completa.',
  HOTEL_OWNER: 'Como el gerente general, más la aprobación de la propiedad.',
  REVENUE_MANAGER:
    'Libertad comercial amplia: tarifas, disponibilidad, restricciones, promociones y distribución. No administra usuarios ni publica contratos.',
  ECOMMERCE:
    'Analiza datos, identifica oportunidades y revisa el competitive set. No modifica nada directamente, pero puede proponer cambios que otro confirma.',
  RESERVATION_AGENT: 'Opera reservas y cupos del día a día.',
  FINANCE: 'Crédito de mayoristas, facturación y lectura de producción.',
  CONNECTIVITY_ADMIN: 'Channel managers, mapeos y salud del inventario.',
  AGENCY_ADMIN: 'Comprador. Ve y reserva lo que su contrato le habilita.',
  SUPPORT: 'Personal de Wetriip. Lee todo, no cambia nada.',
  SUPER_ADMIN: 'Administrador de la plataforma Wetriip.',
};
