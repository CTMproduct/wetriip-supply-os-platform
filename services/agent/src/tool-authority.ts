import { DomainError, Permission } from '@wetriip/contracts';
import { assertCan } from '@wetriip/domain';
import { RequestContext } from '@wetriip/service-kit';

/**
 * What each chat tool is allowed to touch.
 *
 * This closes a real privilege escalation. The gateway required only
 * `agent.use` to open the chat, and `ChatToolsService.run()` dispatched on the
 * tool name without checking anything — so a reservations agent with no
 * `analytics.read` could ask the assistant about revenue and the assistant
 * would fetch it. The tools were more privileged than the person holding them.
 *
 * The system prompt does tell the model not to do that. **A prompt is not a
 * security boundary.** A model can be argued with; a table cannot.
 *
 * Every tool therefore declares the permission it needs and, where it acts on
 * one property, how to find that property in its own input — so property scope
 * is enforced too, not only the permission.
 */
export interface ToolAuthority {
  permission: Permission;
  /** Pull the property id out of the tool's input, when it targets one. */
  propertyFrom?: (input: any) => string | undefined;
  /** Does the tool reach data that leaves the platform in an audit? */
  sensitivity: 'PUBLIC' | 'OPERATIONAL' | 'COMMERCIAL' | 'FINANCIAL';
}

const byPropertyId = (input: any) => input?.propertyId;

export const TOOL_AUTHORITY: Record<string, ToolAuthority> = {
  list_properties: { permission: 'property.read', sensitivity: 'OPERATIONAL' },
  list_organizations: { permission: 'partners.read', sensitivity: 'COMMERCIAL' },

  get_revenue_advisory: {
    permission: 'analytics.read',
    propertyFrom: byPropertyId,
    sensitivity: 'COMMERCIAL',
  },
  get_partner_production: {
    permission: 'analytics.read',
    propertyFrom: byPropertyId,
    sensitivity: 'COMMERCIAL',
  },
  get_property_demand: {
    permission: 'analytics.read',
    propertyFrom: byPropertyId,
    sensitivity: 'COMMERCIAL',
  },
  get_travel_flow: { permission: 'analytics.read', sensitivity: 'COMMERCIAL' },

  diagnose_no_sales: {
    permission: 'analytics.read',
    propertyFrom: byPropertyId,
    sensitivity: 'OPERATIONAL',
  },
  get_availability: {
    permission: 'rates.read',
    propertyFrom: byPropertyId,
    sensitivity: 'COMMERCIAL',
  },
  get_ari_health: {
    permission: 'connectivity.read',
    propertyFrom: byPropertyId,
    sensitivity: 'OPERATIONAL',
  },
  get_connectivity_health: { permission: 'connectivity.read', sensitivity: 'OPERATIONAL' },

  list_promotions: {
    permission: 'promotions.read',
    propertyFrom: byPropertyId,
    sensitivity: 'COMMERCIAL',
  },
  list_contracts: { permission: 'contracts.read', sensitivity: 'FINANCIAL' },
  get_property_content: {
    permission: 'content.read',
    propertyFrom: byPropertyId,
    sensitivity: 'PUBLIC',
  },
  get_distribution_reach: {
    permission: 'distribution.read',
    propertyFrom: byPropertyId,
    sensitivity: 'COMMERCIAL',
  },
  // The partner directory carries tax identities and credit lines.
  list_partners: { permission: 'partners.read', sensitivity: 'FINANCIAL' },

  list_group_requests: {
    permission: 'groups.read',
    propertyFrom: byPropertyId,
    sensitivity: 'COMMERCIAL',
  },
  get_group_policy: {
    permission: 'groups.read',
    propertyFrom: byPropertyId,
    sensitivity: 'COMMERCIAL',
  },
  list_event_spaces: {
    permission: 'events.read',
    propertyFrom: byPropertyId,
    sensitivity: 'COMMERCIAL',
  },
  quote_event_space: { permission: 'events.read', sensitivity: 'COMMERCIAL' },

  // `propose_change` writes nothing by itself: it validates, simulates and
  // evaluates policy against the command's OWN permission, which is stricter
  // than anything that could be declared here. Reaching it needs only the right
  // to use the assistant.
  propose_change: { permission: 'agent.use', sensitivity: 'OPERATIONAL' },
};

/**
 * The single enforcement point, called before the dispatch switch.
 *
 * An unknown tool is refused rather than passed through. A tool added without
 * an entry here would otherwise inherit no checks at all, which is exactly how
 * this class of hole reappears.
 */
export function authorizeTool(ctx: RequestContext, name: string, input: any): ToolAuthority {
  const authority = TOOL_AUTHORITY[name];
  if (!authority) {
    throw new DomainError({
      code: 'NOT_IMPLEMENTED',
      message: `The assistant has no tool called ${name}.`,
      owner: 'Platform Security',
      remediation: 'Every tool must declare the permission it needs in TOOL_AUTHORITY.',
    });
  }

  assertCan(
    {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
      role: ctx.role as any,
      permissions: ctx.permissions,
      propertyIds: ctx.propertyIds,
      status: ctx.status,
    },
    authority.permission,
    authority.propertyFrom?.(input),
  );

  return authority;
}
