import {
  CreditDecision,
  DistributionDecision,
  DistributionPolicyRef,
  DistributionRequest,
} from '@wetriip/contracts';

/**
 * Distribution eligibility.
 *
 * Answers one question: may this buyer see this hotel at all?
 *
 * It runs BEFORE contracts and before pricing. A hotel that is closed to a
 * market should never reach the point of having a rate computed for it — both
 * because it is wasted work and because a rate that leaks into a channel the
 * hotel excluded is the failure everyone in this industry has been burned by.
 *
 * Like sellability, every rule reports its own result. "You cannot see this
 * hotel" is useless; "this hotel is open to selected partners and you are not
 * on the list" is actionable.
 */
export function evaluateDistribution(
  policy: DistributionPolicyRef | null,
  request: DistributionRequest,
): DistributionDecision {
  const checks: DistributionDecision['checks'] = [];

  // No policy means the hotel never expressed a preference. Defaulting to open
  // is the pragmatic choice for onboarding, and it is stated rather than
  // silent.
  if (!policy) {
    return {
      allowed: true,
      mode: 'MARKETPLACE_OPEN',
      checks: [
        {
          code: 'MODE',
          label: 'No distribution policy set; defaults to marketplace-open',
          passed: true,
          detail: 'Set a policy to restrict markets or partners.',
        },
      ],
      deniedBy: [],
      reason: null,
    };
  }

  const deny = (code: DistributionDecision['checks'][number]['code'], label: string, detail: string) => {
    checks.push({ code, label, passed: false, detail });
  };
  const pass = (code: DistributionDecision['checks'][number]['code'], label: string, detail?: string) => {
    checks.push({ code, label, passed: true, detail });
  };

  // ── 1. Mode ──────────────────────────────────────────────
  if (policy.mode === 'CLOSED') {
    deny('MODE', 'Distribution mode', 'The hotel has closed distribution entirely.');
  } else {
    pass('MODE', 'Distribution mode', policy.mode);
  }

  // ── 2. Partner identity ──────────────────────────────────
  // A blocklist wins over everything, including an allow list. If a hotel has
  // explicitly blocked a partner, no other rule should let them back in.
  if (policy.blockedPartnerIds.includes(request.organizationId)) {
    deny('PARTNER_BLOCKED', 'Partner not blocked', 'This partner is explicitly blocked.');
  } else {
    pass('PARTNER_BLOCKED', 'Partner not blocked');
  }

  if (policy.mode === 'SELECTED_PARTNERS') {
    const allowed = policy.allowedPartnerIds.includes(request.organizationId);
    checks.push({
      code: 'PARTNER_ALLOWED',
      label: 'Partner on the allow list',
      passed: allowed,
      detail: allowed
        ? undefined
        : `The hotel distributes to ${policy.allowedPartnerIds.length} selected partner(s) and this is not one of them.`,
    });
  }

  if (policy.allowedPartnerTypes.length) {
    const ok = policy.allowedPartnerTypes.includes(request.organizationType as any);
    checks.push({
      code: 'PARTNER_TYPE',
      label: 'Partner type permitted',
      passed: ok,
      detail: ok
        ? undefined
        : `Open to ${policy.allowedPartnerTypes.join(', ')}; this buyer is a ${request.organizationType}.`,
    });
  }

  // ── 3. Market ────────────────────────────────────────────
  if (policy.blockedMarkets.includes(request.market)) {
    deny('MARKET_BLOCKED', 'Market not blocked', `Market ${request.market} is blocked.`);
  } else {
    pass('MARKET_BLOCKED', 'Market not blocked');
  }

  if (policy.allowedMarkets.length) {
    const ok = policy.allowedMarkets.includes(request.market);
    checks.push({
      code: 'MARKET_ALLOWED',
      label: 'Market on the allow list',
      passed: ok,
      detail: ok
        ? undefined
        : `Distributed to ${policy.allowedMarkets.join(', ')} only; this request is from ${request.market}.`,
    });
  }

  // ── 4. Channel ───────────────────────────────────────────
  if (policy.allowedChannels.length) {
    const ok = policy.allowedChannels.includes(request.channel as any);
    checks.push({
      code: 'CHANNEL',
      label: 'Channel permitted',
      passed: ok,
      detail: ok ? undefined : `Open to ${policy.allowedChannels.join(', ')}, not ${request.channel}.`,
    });
  }

  // ── 5. Booking window ────────────────────────────────────
  const advance = Math.floor(
    (new Date(`${request.checkIn}T00:00:00.000Z`).getTime() - request.now.getTime()) / 86_400_000,
  );
  if (policy.minAdvanceDays != null || policy.maxAdvanceDays != null) {
    const tooLate = policy.minAdvanceDays != null && advance < policy.minAdvanceDays;
    const tooEarly = policy.maxAdvanceDays != null && advance > policy.maxAdvanceDays;
    checks.push({
      code: 'ADVANCE_WINDOW',
      label: 'Inside the distribution booking window',
      passed: !tooLate && !tooEarly,
      detail:
        tooLate
          ? `Requires ${policy.minAdvanceDays} days advance; this booking is ${advance} days out.`
          : tooEarly
            ? `Distributed at most ${policy.maxAdvanceDays} days ahead; this booking is ${advance} days out.`
            : undefined,
    });
  }

  // ── 6. Minimum stay ──────────────────────────────────────
  if (policy.minLos != null) {
    const ok = request.nights >= policy.minLos;
    checks.push({
      code: 'MIN_LOS',
      label: 'Meets the distribution minimum stay',
      passed: ok,
      detail: ok ? undefined : `Distribution requires ${policy.minLos} nights; this stay is ${request.nights}.`,
    });
  }

  // ── 7. Rate floor ────────────────────────────────────────
  // The hotel's own floor. It overrides any contract, because a contract the
  // hotel signed a year ago should not be able to sell below the floor it set
  // this morning.
  if (policy.floorRate != null && request.netRate != null) {
    const comparable = request.netRateCurrency === policy.floorCurrency;
    if (!comparable) {
      checks.push({
        code: 'FLOOR_RATE',
        label: 'Above the distribution rate floor',
        passed: true,
        detail: `Floor is ${policy.floorRate} ${policy.floorCurrency} but the offer is in ${request.netRateCurrency}. Not comparable, so not enforced — convert the floor to enforce it.`,
      });
    } else {
      const ok = request.netRate >= policy.floorRate;
      checks.push({
        code: 'FLOOR_RATE',
        label: 'Above the distribution rate floor',
        passed: ok,
        detail: ok
          ? undefined
          : `Net ${request.netRate} ${request.netRateCurrency} is below the ${policy.floorRate} ${policy.floorCurrency} floor.`,
      });
    }
  }

  const failed = checks.filter((c) => !c.passed);
  return {
    allowed: failed.length === 0,
    mode: policy.mode,
    checks,
    deniedBy: failed.map((c) => c.code),
    reason: failed.length ? failed.map((c) => c.detail ?? c.label).join(' ') : null,
  };
}

/**
 * Credit decision.
 *
 * Separate from distribution: a partner can be perfectly entitled to see a
 * hotel and still have no credit left to book it. Collapsing the two would
 * hide the hotel from a partner who is merely behind on payment, which is a
 * commercial decision nobody made.
 */
export function evaluateCredit(args: {
  status: string;
  paymentTerms: string;
  limit: number;
  used: number;
  requested: number;
  currency: string;
  warningPct: number;
}): CreditDecision {
  const available = Math.max(0, args.limit - args.used);
  const utilizationAfter =
    args.limit > 0 ? Math.round(((args.used + args.requested) / args.limit) * 1000) / 10 : 0;

  const base: CreditDecision = {
    allowed: true,
    reason: null,
    requiresPrepay: args.paymentTerms === 'PREPAY',
    limit: args.limit,
    used: args.used,
    available,
    requested: args.requested,
    currency: args.currency,
    utilizationAfterPct: utilizationAfter,
    warning: null,
  };

  if (args.status === 'SUSPENDED') {
    return { ...base, allowed: false, reason: 'Partner account is suspended.' };
  }
  if (args.status === 'PENDING') {
    return {
      ...base,
      allowed: false,
      reason: 'Partner onboarding is not complete. Activate the profile before transacting.',
    };
  }
  if (args.status === 'ON_HOLD') {
    return {
      ...base,
      allowed: false,
      reason: 'Partner is on hold. Clear the hold or take prepayment.',
    };
  }

  // Prepay partners never draw on credit, so the limit is irrelevant to them.
  if (args.paymentTerms === 'PREPAY') {
    return { ...base, allowed: true, requiresPrepay: true };
  }

  if (args.requested > available) {
    return {
      ...base,
      allowed: false,
      reason: `Requested ${args.requested} ${args.currency} exceeds the ${available} ${args.currency} available on a ${args.limit} limit.`,
    };
  }

  if (utilizationAfter >= args.warningPct) {
    return {
      ...base,
      warning: `This booking takes utilization to ${utilizationAfter}% of the credit line.`,
    };
  }

  return base;
}
