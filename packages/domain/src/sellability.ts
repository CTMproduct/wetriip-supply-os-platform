import {
  EffectiveAriRow,
  PredicateResult,
  SellabilityContext,
  SellabilityResult,
} from '@wetriip/contracts';

/**
 * Sellability Engine.
 *
 *   SELLABLE = property_approved ∧ mapping_active ∧ ari_fresh
 *            ∧ availability > 0 ∧ property_open ∧ restrictions_satisfied
 *            ∧ price_valid ∧ contract_active ∧ buyer_eligible
 *
 * Two design choices matter more than the formula:
 *
 *  1. Every predicate runs. We do not short-circuit, because "the first reason
 *     it failed" is a worse answer than "all four reasons it failed" when a
 *     revenue manager is trying to fix their hotel.
 *  2. A predicate that could not be evaluated reports evaluated:false instead
 *     of quietly passing. Missing input is not a green light.
 */
export function evaluateSellability(
  cell: EffectiveAriRow | null,
  ctx: SellabilityContext,
): SellabilityResult {
  const p: PredicateResult[] = [];

  // 1 — Approval is a workflow state, never proof of operational health.
  p.push({
    code: 'PROPERTY_APPROVED',
    ok: ctx.propertyStatus === 'APPROVED',
    evaluated: true,
    label: 'Property approved',
    evidence: { status: ctx.propertyStatus },
    owner: 'Catalog',
    remediation:
      ctx.propertyStatus === 'APPROVED' ? undefined : 'Complete and approve the property workflow.',
    autoFixable: false,
  });

  // 2 — Mapping
  p.push({
    code: 'MAPPING_ACTIVE',
    ok: ctx.mappingActive,
    evaluated: true,
    label: 'Active published mapping',
    evidence: { mappingVersion: ctx.mappingVersion ?? null },
    owner: 'Catalog',
    remediation: ctx.mappingActive
      ? undefined
      : 'Publish a mapping version linking remote room and rate codes.',
    autoFixable: false,
  });

  // 3 — Freshness
  const freshOk = !!cell && !cell.stale;
  p.push({
    code: 'ARI_FRESH',
    ok: freshOk,
    evaluated: !!cell,
    label: 'ARI within freshness SLA',
    evidence: {
      freshnessSeconds: cell?.freshnessSeconds ?? null,
      slaSeconds: ctx.freshnessSlaSeconds,
      lastSource: cell?.explanation?.fields?.baseAmount?.source ?? null,
    },
    owner: 'Connectivity',
    remediation: freshOk
      ? undefined
      : 'Trigger a reconciliation pull; escalate to the channel manager if the gap exceeds SLA.',
    autoFixable: true,
  });

  // 4 — Inventory
  const availOk = !!cell && cell.available > 0;
  p.push({
    code: 'AVAILABILITY_POSITIVE',
    ok: availOk,
    evaluated: !!cell,
    label: 'Inventory available',
    evidence: { available: cell?.available ?? null },
    owner: 'Supplier',
    remediation: availOk ? undefined : 'Open inventory in the channel manager or via a managed override.',
    autoFixable: true,
  });

  // 5 — Openness
  const openOk = !!cell && cell.open;
  p.push({
    code: 'PROPERTY_OPEN',
    ok: openOk,
    evaluated: !!cell,
    label: 'Open for sale',
    evidence: { open: cell?.open ?? null },
    owner: 'Supplier',
    remediation: openOk ? undefined : 'Lift the stop-sell for these dates.',
    autoFixable: true,
  });

  // 6 — Restrictions. Only meaningful with a stay context.
  if (cell && ctx.stay) {
    const failures: string[] = [];
    if (ctx.stay.nights < cell.minLos) failures.push(`minLOS ${cell.minLos} > ${ctx.stay.nights} nights`);
    if (cell.maxLos && ctx.stay.nights > cell.maxLos)
      failures.push(`maxLOS ${cell.maxLos} < ${ctx.stay.nights} nights`);
    if (ctx.stay.isArrival && cell.closedToArrival) failures.push('closed to arrival');
    if (ctx.stay.isDeparture && cell.closedToDeparture) failures.push('closed to departure');

    const daysAhead = Math.floor(
      (new Date(`${ctx.stay.checkIn}T00:00:00.000Z`).getTime() - ctx.now.getTime()) / 86_400_000,
    );
    if (cell.releaseDays > 0 && daysAhead < cell.releaseDays)
      failures.push(`release ${cell.releaseDays}d, only ${daysAhead}d ahead`);
    if (cell.bookingGap > 0 && daysAhead < cell.bookingGap)
      failures.push(`booking gap ${cell.bookingGap}d, only ${daysAhead}d ahead`);

    p.push({
      code: 'RESTRICTIONS_SATISFIED',
      ok: failures.length === 0,
      evaluated: true,
      label: 'Stay restrictions satisfied',
      evidence: {
        minLos: cell.minLos,
        maxLos: cell.maxLos,
        cta: cell.closedToArrival,
        ctd: cell.closedToDeparture,
        releaseDays: cell.releaseDays,
        failures,
      },
      owner: 'Supplier',
      remediation: failures.length ? `Review restrictions: ${failures.join('; ')}.` : undefined,
      autoFixable: true,
    });
  } else {
    p.push({
      code: 'RESTRICTIONS_SATISFIED',
      ok: false,
      evaluated: false,
      label: 'Stay restrictions satisfied',
      evidence: { reason: 'no stay context supplied' },
      owner: 'Supplier',
      autoFixable: false,
    });
  }

  // 7 — Price sanity. A price of zero, a missing currency or an absurd amount
  // is quarantined rather than sold.
  const priceOk =
    !!cell && !!cell.currency && cell.baseAmount != null && cell.baseAmount > 0 && cell.baseAmount < 1e9;
  p.push({
    code: 'PRICE_VALID',
    ok: priceOk,
    evaluated: !!cell,
    label: 'Price valid',
    evidence: { currency: cell?.currency ?? null, baseAmount: cell?.baseAmount ?? null },
    owner: 'Pricing',
    remediation: priceOk ? undefined : 'Quarantined: fix currency, amount range or tax configuration.',
    autoFixable: false,
  });

  // 8 — Contract
  if (ctx.contract) {
    const c = ctx.contract;
    const today = ctx.now.toISOString().slice(0, 10);
    const active = c.status === 'PUBLISHED' && c.validFrom <= today && c.validTo >= today;
    p.push({
      code: 'CONTRACT_ACTIVE',
      ok: active,
      evaluated: true,
      label: 'Contract active',
      evidence: { contractId: c.id, status: c.status, validFrom: c.validFrom, validTo: c.validTo },
      owner: 'Commercial',
      remediation: active ? undefined : 'Renew or publish the contract version.',
      autoFixable: false,
    });
  } else {
    p.push({
      code: 'CONTRACT_ACTIVE',
      ok: false,
      evaluated: ctx.buyer != null,
      label: 'Contract active',
      evidence: { reason: ctx.buyer ? 'no contract between supplier and buyer' : 'no buyer context' },
      owner: 'Commercial',
      remediation: ctx.buyer ? 'Create and publish a contract for this buyer.' : undefined,
      autoFixable: false,
    });
  }

  // 9 — Buyer eligibility
  if (ctx.buyer && ctx.contract) {
    const c = ctx.contract;
    const reasons: string[] = [];
    if (c.markets.length && !c.markets.includes(ctx.buyer.market))
      reasons.push(`market ${ctx.buyer.market} not in contract markets`);
    if (c.channels.length && !c.channels.includes(ctx.buyer.channel))
      reasons.push(`channel ${ctx.buyer.channel} not permitted`);
    if (c.propertyIds.length && cell && !c.propertyIds.includes(cell.propertyId))
      reasons.push('property not included in contract scope');

    p.push({
      code: 'BUYER_ELIGIBLE',
      ok: reasons.length === 0,
      evaluated: true,
      label: 'Buyer eligible',
      evidence: { market: ctx.buyer.market, channel: ctx.buyer.channel, reasons },
      owner: 'Distribution',
      remediation: reasons.length ? `Adjust contract scope: ${reasons.join('; ')}.` : undefined,
      autoFixable: false,
    });
  } else {
    p.push({
      code: 'BUYER_ELIGIBLE',
      ok: false,
      evaluated: false,
      label: 'Buyer eligible',
      evidence: { reason: 'no buyer/contract context' },
      owner: 'Distribution',
      autoFixable: false,
    });
  }

  const failedCodes = p.filter((x) => !x.ok).map((x) => x.code);
  return {
    sellable: failedCodes.length === 0,
    predicates: p,
    failedCodes,
    evaluatedAt: ctx.now.toISOString(),
  };
}

/** Calendar/health view: the buyer-scoped predicates are not applicable, so we
 *  score only what a hotel can act on by itself. */
export function evaluateSupplySideSellability(
  cell: EffectiveAriRow | null,
  ctx: Omit<SellabilityContext, 'buyer' | 'contract'>,
): SellabilityResult {
  const full = evaluateSellability(cell, { ...ctx, buyer: null, contract: null });
  const supplySide = full.predicates.filter(
    (x) => x.code !== 'CONTRACT_ACTIVE' && x.code !== 'BUYER_ELIGIBLE',
  );
  const failed = supplySide.filter((x) => !x.ok && x.evaluated).map((x) => x.code);
  return {
    sellable: failed.length === 0,
    predicates: supplySide,
    failedCodes: failed,
    evaluatedAt: full.evaluatedAt,
  };
}
