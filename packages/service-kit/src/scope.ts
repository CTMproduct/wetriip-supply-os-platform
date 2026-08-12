import { RequestContext } from './context';

/**
 * Tenant and property scoping, as one primitive.
 *
 * `propertyIds` and `canOnProperty()` existed, and several queries simply did
 * not use them — so a revenue manager restricted to two hotels could, through
 * the wrong route, list every property in the tenant. Fixing that route by
 * route guarantees the next route added forgets again.
 *
 * So the scope is a value you compose into a `where` clause, and reviewing a
 * query becomes "does this spread a scope?" instead of "did the author
 * remember three separate rules?".
 *
 *   BUYERS see their own organization's data.
 *   HOTEL STAFF see their organization, narrowed to their property scope.
 *   PLATFORM STAFF see the tenant.
 */

const PLATFORM_ROLES = new Set(['SUPER_ADMIN', 'SUPPORT']);

/**
 * Roles that BUY supply rather than own it.
 *
 * This distinction matters more than it looks. Narrowing a buyer to its own
 * organization would hide every hotel from it — which is the entire inventory
 * it exists to purchase. A buyer's access to supply is governed downstream by
 * distribution policy and contracts, which is where a hotel actually decides
 * who may see it. Organization scoping is a SUPPLY-side rule.
 */
const BUYER_ROLES = new Set(['AGENCY_ADMIN']);

export function isPlatformStaff(ctx: RequestContext): boolean {
  return PLATFORM_ROLES.has(ctx.role);
}

export function isBuyer(ctx: RequestContext): boolean {
  return BUYER_ROLES.has(ctx.role);
}

/** Scope for a query whose rows ARE properties (`Property.id`). */
export function propertyScope(ctx: RequestContext): Record<string, unknown> {
  if (isPlatformStaff(ctx)) return { tenantId: ctx.tenantId };
  // A buyer sees the tenant's supply and is gated by distribution and
  // contracts, not by which organization it belongs to.
  if (isBuyer(ctx)) return { tenantId: ctx.tenantId };
  return {
    tenantId: ctx.tenantId,
    ...(ctx.organizationId ? { organizationId: ctx.organizationId } : {}),
    // An empty scope means "every property in my organization" — not "every
    // property in the tenant". The organization clause above is what makes the
    // difference, and it is why both live in one place.
    ...(ctx.propertyIds?.length ? { id: { in: ctx.propertyIds } } : {}),
  };
}

/**
 * Look up ONE property, inside the caller's scope.
 *
 * Never write `{ id, ...propertyScope(ctx) }`. The scope also carries an `id`
 * clause when the caller is property-scoped, and the spread silently overwrites
 * the id you asked for — so the query returns a DIFFERENT property with a 200,
 * which is worse than leaking one: the caller is shown another hotel's data
 * under the URL of the hotel they requested.
 *
 * `AND` keeps both constraints, which is what "this property, if I may see it"
 * actually means.
 */
export function scopedPropertyWhere(ctx: RequestContext, id: string): Record<string, unknown> {
  return { AND: [{ id }, propertyScope(ctx)] };
}

/** Scope for a query whose rows REFERENCE a property (`propertyId`). */
export function byPropertyScope(ctx: RequestContext): Record<string, unknown> {
  if (isPlatformStaff(ctx)) return { tenantId: ctx.tenantId };
  return {
    tenantId: ctx.tenantId,
    ...(ctx.propertyIds?.length ? { propertyId: { in: ctx.propertyIds } } : {}),
  };
}

/** Scope for rows owned by an organization (partners, users, contracts). */
export function organizationScope(ctx: RequestContext): Record<string, unknown> {
  if (isPlatformStaff(ctx)) return { tenantId: ctx.tenantId };
  return { tenantId: ctx.tenantId, organizationId: ctx.organizationId };
}

/**
 * Whether a single property id is inside the caller's scope.
 *
 * Used on the read-one paths, where a `findFirst` by id would otherwise return
 * a property the caller may not see, and the caller would learn it exists.
 */
export function withinPropertyScope(ctx: RequestContext, propertyId: string): boolean {
  if (isPlatformStaff(ctx)) return true;
  if (!ctx.propertyIds?.length) return true;
  return ctx.propertyIds.includes(propertyId);
}

/**
 * Namespace an idempotency key to its tenant.
 *
 * `Booking.idempotencyKey` was globally unique and the lock was
 * `booking:<key>`. Two unrelated companies sending the same key — which is
 * likely, because keys are often derived from a PMS reference or a date —
 * would collide, and one of them would silently receive the other's outcome.
 */
export function scopedIdempotencyKey(tenantId: string, scope: string, key: string): string {
  return `tenant:${tenantId}:${scope}:${key}`;
}
