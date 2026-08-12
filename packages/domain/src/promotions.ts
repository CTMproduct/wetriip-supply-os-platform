import { PromotionEvaluation, PromotionRef, StayDate } from '@wetriip/contracts';
import Decimal from 'decimal.js';

/**
 * Promotion Engine.
 *
 * Promotions are evaluated, never executed: the engine returns why each one
 * did or did not apply and how much it took off. That trace is what the agent
 * reads back to a hotel and what an agency sees when it disputes a rate.
 */

export interface PromotionContext {
  now: Date;
  bookingDate: StayDate;
  checkIn: StayDate;
  checkOut: StayDate;
  nights: number;
  stayDates: StayDate[];
  adults: number;
  children: number;
  roomTypeCode: string;
  ratePlanCode: string;
  propertyId: string;
  buyer: { organizationId: string; market: string; channel: string };
  promoCode?: string | null;
  /** Per-night net amounts in supplier currency, aligned with stayDates. */
  perNight: number[];
}

function daysBetween(a: StayDate, b: StayDate): number {
  return Math.round(
    (new Date(`${b}T00:00:00.000Z`).getTime() - new Date(`${a}T00:00:00.000Z`).getTime()) /
      86_400_000,
  );
}

/**
 * Eligibility. Returns every failing reason, not just the first — a hotel
 * asking "why didn't my promo fire?" deserves the complete list.
 */
export function evaluateEligibility(
  promo: PromotionRef,
  ctx: PromotionContext,
): { eligible: boolean; reasons: string[]; matchedNights: number[] } {
  const reasons: string[] = [];
  const d = promo.definition;
  const today = ctx.now.toISOString().slice(0, 10);

  if (promo.status !== 'ACTIVE') reasons.push(`promotion status is ${promo.status}`);
  if (promo.validFrom > today) reasons.push(`not yet valid (from ${promo.validFrom})`);
  if (promo.validTo < today) reasons.push(`expired (until ${promo.validTo})`);

  if (d.scope.propertyId !== ctx.propertyId) reasons.push('different property');
  if (d.scope.roomTypeCodes?.length && !d.scope.roomTypeCodes.includes(ctx.roomTypeCode))
    reasons.push(`room type ${ctx.roomTypeCode} out of scope`);
  if (d.scope.ratePlanCodes?.length && !d.scope.ratePlanCodes.includes(ctx.ratePlanCode))
    reasons.push(`rate plan ${ctx.ratePlanCode} out of scope`);

  const a = d.audience ?? {};
  if (a.markets?.length && !a.markets.includes(ctx.buyer.market))
    reasons.push(`market ${ctx.buyer.market} not targeted`);
  if (a.organizationIds?.length && !a.organizationIds.includes(ctx.buyer.organizationId))
    reasons.push('buyer organization not targeted');
  if (a.channels?.length && !a.channels.includes(ctx.buyer.channel as any))
    reasons.push(`channel ${ctx.buyer.channel} not targeted`);
  if (a.promoCode && a.promoCode !== ctx.promoCode) reasons.push('promo code missing or wrong');

  const bw = d.bookingWindow ?? {};
  const advance = daysBetween(ctx.bookingDate, ctx.checkIn);
  if (bw.minAdvanceDays != null && advance < bw.minAdvanceDays)
    reasons.push(`needs ${bw.minAdvanceDays}d advance, booking is ${advance}d ahead`);
  if (bw.maxAdvanceDays != null && advance > bw.maxAdvanceDays)
    reasons.push(`max ${bw.maxAdvanceDays}d advance, booking is ${advance}d ahead`);
  if (bw.from && ctx.bookingDate < bw.from) reasons.push(`booking window starts ${bw.from}`);
  if (bw.to && ctx.bookingDate > bw.to) reasons.push(`booking window ended ${bw.to}`);

  const los = d.los ?? {};
  if (los.min != null && ctx.nights < los.min) reasons.push(`min LOS ${los.min}, stay is ${ctx.nights}`);
  if (los.max != null && ctx.nights > los.max) reasons.push(`max LOS ${los.max}, stay is ${ctx.nights}`);

  const occ = d.occupancy ?? {};
  if (occ.minAdults != null && ctx.adults < occ.minAdults)
    reasons.push(`needs ${occ.minAdults}+ adults`);
  if (occ.maxAdults != null && ctx.adults > occ.maxAdults)
    reasons.push(`max ${occ.maxAdults} adults`);

  // The stay window is applied PER NIGHT. A 5-night stay that only overlaps
  // the promotion for 2 nights gets the discount on those 2 nights, not on
  // the whole booking and not on nothing.
  const matchedNights: number[] = [];
  ctx.stayDates.forEach((sd, i) => {
    if (sd < d.stayWindow.from || sd > d.stayWindow.to) return;
    if (d.stayWindow.daysOfWeek?.length) {
      const dow = new Date(`${sd}T00:00:00.000Z`).getUTCDay();
      if (!d.stayWindow.daysOfWeek.includes(dow)) return;
    }
    matchedNights.push(i);
  });
  if (matchedNights.length === 0) reasons.push('no night falls inside the stay window');

  return { eligible: reasons.length === 0, reasons, matchedNights };
}

export function computeDiscount(
  promo: PromotionRef,
  ctx: PromotionContext,
  matchedNights: number[],
  /** Running amount after previously stacked promotions, supplier currency. */
  currentAmount: number,
): number {
  const d = promo.definition.discount;
  const matchedBase = matchedNights.reduce((s, i) => s + (ctx.perNight[i] ?? 0), 0);
  const totalBase = ctx.perNight.reduce((s, n) => s + n, 0);
  // When stacking, the second promotion discounts the already-reduced amount.
  const scale = totalBase > 0 ? new Decimal(currentAmount).div(totalBase) : new Decimal(1);
  const effectiveBase = new Decimal(matchedBase).mul(scale);

  switch (d.type) {
    case 'PERCENTAGE':
      return effectiveBase.mul(d.value).div(100).toDecimalPlaces(4).toNumber();
    case 'FIXED':
      // A fixed discount can never exceed what is actually being charged.
      return Decimal.min(new Decimal(d.value), effectiveBase).toDecimalPlaces(4).toNumber();
    case 'FREE_NIGHTS': {
      const stayN = d.stayNights!;
      const payN = d.payNights!;
      const blocks = Math.floor(matchedNights.length / stayN);
      if (blocks < 1) return 0;
      const freePerBlock = stayN - payN;
      // The cheapest nights are the free ones — the industry convention and
      // the conservative choice for the hotel.
      const prices = matchedNights.map((i) => ctx.perNight[i] ?? 0).sort((a, b) => a - b);
      let sum = new Decimal(0);
      for (let i = 0; i < blocks * freePerBlock && i < prices.length; i++) {
        sum = sum.add(prices[i]);
      }
      return sum.mul(scale).toDecimalPlaces(4).toNumber();
    }
    default:
      return 0;
  }
}

/**
 * Deterministic selection order, documented because it decides money:
 *   1. keep only eligible promotions
 *   2. sort by priority ascending, then by discount descending
 *   3. apply the first
 *   4. keep applying further promotions ONLY while every one applied so far
 *      and the next one are both stackable
 */
export function applyPromotions(
  promotions: PromotionRef[],
  ctx: PromotionContext,
): { evaluations: PromotionEvaluation[]; totalDiscount: number; appliedIds: string[] } {
  const totalBase = ctx.perNight.reduce((s, n) => s + n, 0);
  const evaluations: PromotionEvaluation[] = [];

  const candidates = promotions.map((p) => {
    const e = evaluateEligibility(p, ctx);
    return { promo: p, ...e };
  });

  const eligible = candidates
    .filter((c) => c.eligible)
    .map((c) => ({
      ...c,
      provisional: computeDiscount(c.promo, ctx, c.matchedNights, totalBase),
    }))
    .sort((a, b) => {
      if (a.promo.priority !== b.promo.priority) return a.promo.priority - b.promo.priority;
      return b.provisional - a.provisional;
    });

  const appliedIds: string[] = [];
  let running = totalBase;
  let stackingOpen = true;

  for (const c of eligible) {
    if (appliedIds.length > 0 && (!stackingOpen || !c.promo.stackable)) {
      evaluations.push({
        promotionId: c.promo.id,
        code: c.promo.code,
        name: c.promo.name,
        eligible: true,
        reasons: ['not applied: a non-stackable promotion is already in effect'],
        discountAmount: 0,
        priority: c.promo.priority,
        stackable: c.promo.stackable,
        applied: false,
      });
      continue;
    }

    const amount = computeDiscount(c.promo, ctx, c.matchedNights, running);
    if (amount <= 0) {
      evaluations.push({
        promotionId: c.promo.id,
        code: c.promo.code,
        name: c.promo.name,
        eligible: true,
        reasons: ['eligible but produced no discount'],
        discountAmount: 0,
        priority: c.promo.priority,
        stackable: c.promo.stackable,
        applied: false,
      });
      continue;
    }

    running = Math.max(0, new Decimal(running).sub(amount).toNumber());
    appliedIds.push(c.promo.id);
    if (!c.promo.stackable) stackingOpen = false;

    evaluations.push({
      promotionId: c.promo.id,
      code: c.promo.code,
      name: c.promo.name,
      eligible: true,
      reasons: [`applied to ${c.matchedNights.length} night(s)`],
      discountAmount: amount,
      priority: c.promo.priority,
      stackable: c.promo.stackable,
      applied: true,
    });
  }

  for (const c of candidates.filter((x) => !x.eligible)) {
    evaluations.push({
      promotionId: c.promo.id,
      code: c.promo.code,
      name: c.promo.name,
      eligible: false,
      reasons: c.reasons,
      discountAmount: 0,
      priority: c.promo.priority,
      stackable: c.promo.stackable,
      applied: false,
    });
  }

  return {
    evaluations,
    totalDiscount: new Decimal(totalBase).sub(running).toDecimalPlaces(4).toNumber(),
    appliedIds,
  };
}
