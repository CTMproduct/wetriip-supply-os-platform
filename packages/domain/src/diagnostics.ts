import {
  DiagnosticFunnelStage,
  DiagnosticReport,
  EffectiveAriRow,
  StayDate,
  StructuredCommand,
} from '@wetriip/contracts';

/**
 * Diagnostic Engine — "why am I not selling?"
 *
 * The point is causality, not a dashboard. Every stage of the funnel reports
 * how many candidate date/room/rate combinations survived it, so the drop is
 * attributable to one stage rather than to a vague sense that something is off.
 *
 * The distinction that makes this useful: a technical failure and a commercial
 * failure look identical from the outside ("no bookings") and need completely
 * different people to fix them. This separates them explicitly.
 */

export interface DiagnosticInput {
  now: Date;
  property: { id: string; name: string; status: string; currency: string };
  window: { from: StayDate; to: StayDate };
  cells: EffectiveAriRow[];
  mappingActive: boolean;
  mappingVersion: number | null;
  connections: Array<{
    id: string;
    provider: string;
    status: string;
    lastEventAt: Date | null;
    displayName: string;
  }>;
  contracts: Array<{ id: string; code: string; buyerOrgId: string; status: string; markets: string[] }>;
  /** Demand observed for this property in the window. */
  searchCount: number;
  bookingCount: number;
  /** Competitive set median rate in property currency, when available. */
  compSetMedian: number | null;
  freshnessSlaSeconds: number;
  blockedBuyers: Array<{ organizationId: string; name: string; reason: string }>;
}

export function diagnose(input: DiagnosticInput): DiagnosticReport {
  const total = input.cells.length;
  const findings: DiagnosticReport['findings'] = [];
  const funnel: DiagnosticFunnelStage[] = [];

  funnel.push({
    stage: 'SEARCHES',
    label: 'Search requests received',
    passed: input.searchCount,
    total: input.searchCount,
    ok: input.searchCount > 0,
    detail: input.searchCount === 0 ? 'No buyer searched this property in the window.' : undefined,
  });
  if (input.searchCount === 0) {
    findings.push({
      code: 'NO_DEMAND',
      severity: 'WARNING',
      title: 'No searches reached this property',
      detail:
        'Nothing downstream can explain the absence of bookings: there was no demand to convert. Check distribution reach and buyer eligibility before touching price.',
      owner: 'Distribution',
      autoFixable: false,
    });
  }

  // Mapping
  funnel.push({
    stage: 'MAPPED',
    label: 'Active mapping published',
    passed: input.mappingActive ? total : 0,
    total,
    ok: input.mappingActive,
    detail: input.mappingActive ? `mapping v${input.mappingVersion}` : 'No active mapping version.',
  });
  if (!input.mappingActive) {
    findings.push({
      code: 'MAPPING_INACTIVE',
      severity: 'CRITICAL',
      title: 'No active mapping',
      detail:
        'Remote room and rate codes are not linked to a published mapping version, so incoming ARI cannot be attributed to any sellable product.',
      owner: 'Catalog',
      autoFixable: false,
    });
  }

  // Freshness — per connection, because "ARI is stale" is useless without
  // knowing which feed died.
  const fresh = input.cells.filter((c) => !c.stale).length;
  funnel.push({
    stage: 'FRESH_ARI',
    label: 'ARI within freshness SLA',
    passed: fresh,
    total,
    ok: total > 0 && fresh === total,
    detail: total ? `${total - fresh} stale cell(s)` : 'no cells',
  });

  for (const conn of input.connections) {
    const ageSec = conn.lastEventAt
      ? Math.round((input.now.getTime() - conn.lastEventAt.getTime()) / 1000)
      : null;
    if (ageSec == null || ageSec > input.freshnessSlaSeconds) {
      const hours = ageSec == null ? null : Math.round(ageSec / 3600);
      findings.push({
        code: 'ARI_STALE',
        severity: 'CRITICAL',
        title: `${conn.displayName} has not sent inventory${hours != null ? ` in ${hours}h` : ''}`,
        detail:
          ageSec == null
            ? 'This connection has never delivered an ARI event.'
            : `Last event ${hours}h ago, beyond the ${Math.round(input.freshnessSlaSeconds / 3600)}h SLA. A reconciliation pull can close the gap immediately; if it recurs, escalate to the provider.`,
        owner: 'Connectivity',
        autoFixable: true,
      });
    }
  }

  // Inventory
  const withInventory = input.cells.filter((c) => c.available > 0).length;
  funnel.push({
    stage: 'INVENTORY',
    label: 'Inventory available',
    passed: withInventory,
    total,
    ok: withInventory > 0,
    detail: `${total - withInventory} date(s) at zero`,
  });
  if (total > 0 && withInventory === 0) {
    findings.push({
      code: 'NO_INVENTORY',
      severity: 'CRITICAL',
      title: 'Zero availability across the whole window',
      detail: 'Every date in the window has no inventory. Either the hotel is genuinely full or the feed is sending zeros.',
      owner: 'Supplier',
      autoFixable: true,
    });
  }

  // Restrictions
  const openCells = input.cells.filter((c) => c.open);
  const restricted = openCells.filter((c) => c.closedToArrival || c.minLos > 1);
  funnel.push({
    stage: 'RESTRICTIONS',
    label: 'Not blocked by restrictions',
    passed: openCells.length - restricted.length,
    total: openCells.length,
    ok: restricted.length === 0,
    detail: restricted.length ? `${restricted.length} date(s) with CTA or minLOS` : undefined,
  });
  const ctaDates = openCells.filter((c) => c.closedToArrival).map((c) => c.stayDate);
  if (ctaDates.length) {
    findings.push({
      code: 'CTA_ACTIVE',
      severity: 'WARNING',
      title: `Closed to arrival on ${ctaDates.length} date(s)`,
      detail: `Arrivals are blocked on ${uniqueSorted(ctaDates).slice(0, 8).join(', ')}${ctaDates.length > 8 ? '…' : ''}. A buyer searching a stay that starts on one of those dates will not see this hotel at all.`,
      owner: 'Supplier',
      autoFixable: true,
      suggestedCommand: buildOpenCtaCommand(input.property.id, uniqueSorted(ctaDates)),
    });
  }

  // Contracts
  const activeContracts = input.contracts.filter((c) => c.status === 'PUBLISHED');
  funnel.push({
    stage: 'CONTRACT',
    label: 'Published contracts',
    passed: activeContracts.length,
    total: input.contracts.length || 1,
    ok: activeContracts.length > 0,
    detail: activeContracts.length ? undefined : 'No published contract with any buyer.',
  });
  if (activeContracts.length === 0) {
    findings.push({
      code: 'NO_CONTRACT',
      severity: 'CRITICAL',
      title: 'No published contract',
      detail: 'The hotel can be technically perfect and still be invisible: without a published contract there is no buyer entitled to see it.',
      owner: 'Commercial',
      autoFixable: false,
    });
  }

  // Buyer eligibility
  funnel.push({
    stage: 'BUYER_ELIGIBILITY',
    label: 'Buyers not blocked',
    passed: Math.max(0, activeContracts.length - input.blockedBuyers.length),
    total: activeContracts.length || 1,
    ok: input.blockedBuyers.length === 0,
    detail: input.blockedBuyers.length ? `${input.blockedBuyers.length} buyer(s) blocked` : undefined,
  });
  for (const b of input.blockedBuyers) {
    findings.push({
      code: 'BUYER_BLOCKED',
      severity: 'WARNING',
      title: `${b.name} is blocked`,
      detail: b.reason,
      owner: 'Distribution',
      autoFixable: false,
    });
  }

  // Price competitiveness — the commercial branch. Only reported when we have
  // a comp set; inventing a benchmark would be worse than staying silent.
  const priced = input.cells.filter((c) => c.baseAmount != null && c.open && c.available > 0);
  let priceOk = true;
  let deltaPct: number | null = null;
  if (input.compSetMedian && priced.length) {
    const avg = priced.reduce((s, c) => s + (c.baseAmount ?? 0), 0) / priced.length;
    deltaPct = Math.round(((avg - input.compSetMedian) / input.compSetMedian) * 1000) / 10;
    priceOk = deltaPct <= 10;
    if (!priceOk) {
      findings.push({
        code: 'PRICE_UNCOMPETITIVE',
        severity: 'WARNING',
        title: `Rates are ${deltaPct}% above the competitive set`,
        detail:
          'This is not a technical problem. Connectivity, inventory and restrictions are fine; the offer is simply priced above the market for this window. A geo-fenced promotion can address the gap without moving the public BAR.',
        owner: 'Pricing',
        autoFixable: true,
      });
    }
  }
  funnel.push({
    stage: 'PRICE_COMPETITIVENESS',
    label: 'Price within competitive band',
    passed: priceOk ? priced.length : 0,
    total: priced.length || 1,
    ok: priceOk,
    detail: deltaPct == null ? 'no competitive set data' : `${deltaPct > 0 ? '+' : ''}${deltaPct}% vs comp set`,
  });

  funnel.push({
    stage: 'CONVERSION',
    label: 'Bookings',
    passed: input.bookingCount,
    total: input.searchCount || 1,
    ok: input.bookingCount > 0,
  });

  const critical = findings.filter((f) => f.severity === 'CRITICAL');
  const summary = buildSummary(input, findings, critical, deltaPct);

  return {
    propertyId: input.property.id,
    propertyName: input.property.name,
    window: input.window,
    funnel,
    findings,
    summary,
    generatedAt: input.now.toISOString(),
  };
}

function buildSummary(
  input: DiagnosticInput,
  findings: DiagnosticReport['findings'],
  critical: DiagnosticReport['findings'],
  deltaPct: number | null,
): string {
  if (findings.length === 0) {
    return `No blocking issues found for ${input.property.name} between ${input.window.from} and ${input.window.to}. ${input.searchCount} searches produced ${input.bookingCount} bookings.`;
  }
  if (critical.length > 0) {
    return `Found ${findings.length} issue(s), ${critical.length} of them blocking. ${critical
      .map((c, i) => `${i + 1}. ${c.title}`)
      .join(' ')} Nothing this hotel does commercially will matter until these are cleared.`;
  }
  if (deltaPct != null && deltaPct > 10) {
    return `You are technically healthy and correctly connected. ${input.searchCount} searches reached this property, but the effective rate sits ${deltaPct}% above the competitive set for this window — the problem is commercial, not technical.`;
  }
  return `Found ${findings.length} non-blocking issue(s) for ${input.property.name}.`;
}

function uniqueSorted(a: string[]): string[] {
  return [...new Set(a)].sort();
}

/** A ready-to-approve command. The operator clicks once; the same policy,
 *  simulation and audit path runs as if they had typed it. */
function buildOpenCtaCommand(propertyId: string, dates: StayDate[]): StructuredCommand {
  return {
    kind: 'update_restriction',
    target: {
      propertyId,
      roomTypeCodes: null,
      ratePlanCodes: null,
      from: dates[0],
      to: dates[dates.length - 1],
      daysOfWeek: null,
      occupancy: null,
    },
    restriction: { closedToArrival: false },
    reason: 'Diagnostic: lift closed-to-arrival blocking searched dates',
  } as StructuredCommand;
}
