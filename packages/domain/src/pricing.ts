import {
  ContractRef,
  PriceBreakdown,
  PriceStep,
  PromotionRef,
  StayDate,
  TaxRuleRef,
} from '@wetriip/contracts';
import Decimal from 'decimal.js';
import { FxProvider, buildMoneyTrace, roundForCurrency } from './fx';
import { PromotionContext, applyPromotions } from './promotions';

/**
 * Offer pricing pipeline.
 *
 * Fixed order, every step recorded:
 *
 *   BASE -> OCCUPANCY -> PROMOTION -> CONTRACT -> TAX -> FEE -> FX -> ROUNDING
 *
 * The order is not cosmetic. Applying commission before promotions, or tax
 * before discount, produces a different number and a different invoice. It is
 * fixed here once so that search, re-validation at booking time and the
 * reconciliation job can never disagree.
 *
 * The LLM is not in this file, and never will be. It receives the finished
 * HotelOffer and chooses between offers; it does not compute one.
 */

export interface PricingInput {
  stayDates: StayDate[];
  /** Effective ARI net amount per night, supplier currency. */
  perNightBase: number[];
  supplierCurrency: string;
  buyerCurrency: string;
  normalizationCurrency: string;

  adults: number;
  children: number;
  /** Per-adult-count prices from the ARI cell, when the supplier sends them. */
  occupancyPrices?: Record<string, number> | null;

  promotions: PromotionRef[];
  promotionContext: PromotionContext;

  contract: ContractRef | null;
  taxes: TaxRuleRef[];

  fx: FxProvider;
  at: Date;
}

export function buildPriceBreakdown(input: PricingInput): PriceBreakdown {
  const cur = input.supplierCurrency.toUpperCase();
  const steps: PriceStep[] = [];

  // ── 1. BASE ────────────────────────────────────────────────
  let perNight = [...input.perNightBase];
  let amount = perNight.reduce((s, n) => new Decimal(s).add(n).toNumber(), 0);
  steps.push({
    step: 'BASE',
    label: `Effective ARI base for ${perNight.length} night(s)`,
    input: amount,
    output: amount,
    delta: 0,
    currency: cur,
  });

  // ── 2. OCCUPANCY ───────────────────────────────────────────
  // Only when the supplier actually sent an occupancy grid. We do not invent
  // per-person pricing from a double-occupancy rate.
  const occKey = String(input.adults);
  const occPrice = input.occupancyPrices?.[occKey];
  if (occPrice != null && occPrice > 0) {
    const before = amount;
    perNight = perNight.map(() => occPrice);
    amount = new Decimal(occPrice).mul(perNight.length).toNumber();
    steps.push({
      step: 'OCCUPANCY',
      label: `Occupancy price for ${input.adults} adult(s)`,
      input: before,
      output: amount,
      delta: new Decimal(amount).sub(before).toNumber(),
      currency: cur,
      detail: { occupancy: input.adults, perNight: occPrice },
    });
  }

  // ── 3. PROMOTIONS ──────────────────────────────────────────
  const promoCtx: PromotionContext = { ...input.promotionContext, perNight };
  const promoResult = applyPromotions(input.promotions, promoCtx);
  if (promoResult.totalDiscount > 0) {
    const before = amount;
    amount = new Decimal(amount).sub(promoResult.totalDiscount).toNumber();
    steps.push({
      step: 'PROMOTION',
      label: `${promoResult.appliedIds.length} promotion(s) applied`,
      input: before,
      output: amount,
      delta: -promoResult.totalDiscount,
      currency: cur,
      detail: {
        applied: promoResult.evaluations.filter((e) => e.applied).map((e) => e.code),
      },
    });
  }

  const netAmount = amount;

  // ── 4. CONTRACT ────────────────────────────────────────────
  // NET: the buyer pays net, our margin is the markup we add.
  // COMMISSION: the buyer pays gross, commission is deducted at settlement.
  let commissionAmount = 0;
  if (input.contract) {
    const c = input.contract;
    if (c.markupPct && c.markupPct > 0) {
      const before = amount;
      const markup = new Decimal(amount).mul(c.markupPct).div(100).toDecimalPlaces(4).toNumber();
      amount = new Decimal(amount).add(markup).toNumber();
      steps.push({
        step: 'CONTRACT_MARKUP',
        label: `Contract markup ${c.markupPct}%`,
        input: before,
        output: amount,
        delta: markup,
        currency: cur,
        detail: { contractId: c.id, code: c.code },
      });
    }
    if (c.paymentModel === 'COMMISSION' && c.commissionPct > 0) {
      commissionAmount = new Decimal(amount)
        .mul(c.commissionPct)
        .div(100)
        .toDecimalPlaces(4)
        .toNumber();
      steps.push({
        step: 'CONTRACT_COMMISSION',
        // Commission does not change what the buyer pays — it changes who
        // keeps it. Recording it as a zero-delta step keeps that explicit.
        label: `Commission ${c.commissionPct}% (settled, not added)`,
        input: amount,
        output: amount,
        delta: 0,
        currency: cur,
        detail: { contractId: c.id, commissionAmount },
      });
    }
  }

  // ── 5. TAXES & FEES ────────────────────────────────────────
  let taxAmount = 0;
  let feeAmount = 0;
  for (const t of input.taxes) {
    if (t.included) continue;
    const before = amount;
    let add = 0;
    if (t.mode === 'PERCENTAGE') {
      add = new Decimal(amount).mul(t.value).div(100).toDecimalPlaces(4).toNumber();
    } else if (t.mode === 'FIXED_PER_NIGHT') {
      add = new Decimal(t.value).mul(perNight.length).toDecimalPlaces(4).toNumber();
    } else {
      add = new Decimal(t.value).toDecimalPlaces(4).toNumber();
    }
    const isFee = t.code.toUpperCase().includes('FEE');
    if (isFee) feeAmount = new Decimal(feeAmount).add(add).toNumber();
    else taxAmount = new Decimal(taxAmount).add(add).toNumber();
    amount = new Decimal(amount).add(add).toNumber();
    steps.push({
      step: isFee ? 'FEE' : 'TAX',
      label: `${t.name} (${t.mode === 'PERCENTAGE' ? `${t.value}%` : t.value})`,
      input: before,
      output: amount,
      delta: add,
      currency: cur,
      detail: { code: t.code },
    });
  }

  // ── 6. FX ──────────────────────────────────────────────────
  const money = buildMoneyTrace({
    supplierCurrency: cur,
    supplierAmount: amount,
    normalizationCurrency: input.normalizationCurrency,
    buyerCurrency: input.buyerCurrency,
    fx: input.fx,
    at: input.at,
  });
  if (money.buyerCurrency !== cur) {
    steps.push({
      step: 'FX',
      label: `${cur} -> ${money.buyerCurrency} @ ${money.fx.rate}`,
      input: amount,
      output: money.buyerAmount,
      delta: new Decimal(money.buyerAmount).sub(amount).toNumber(),
      currency: money.buyerCurrency,
      detail: { source: money.fx.source, timestamp: money.fx.timestamp },
    });
  }

  // ── 7. ROUNDING ────────────────────────────────────────────
  const roundedBuyer = roundForCurrency(money.buyerAmount, money.buyerCurrency);
  if (roundedBuyer !== money.buyerAmount) {
    steps.push({
      step: 'ROUNDING',
      label: `Rounded for ${money.buyerCurrency}`,
      input: money.buyerAmount,
      output: roundedBuyer,
      delta: new Decimal(roundedBuyer).sub(money.buyerAmount).toNumber(),
      currency: money.buyerCurrency,
    });
    money.buyerAmount = roundedBuyer;
  }

  return {
    nights: perNight.length,
    perNight: input.stayDates.map((d, i) => ({
      stayDate: d,
      amount: perNight[i] ?? 0,
      currency: cur,
    })),
    steps,
    netAmount: new Decimal(netAmount).toDecimalPlaces(4).toNumber(),
    taxAmount: new Decimal(taxAmount).toDecimalPlaces(4).toNumber(),
    feeAmount: new Decimal(feeAmount).toDecimalPlaces(4).toNumber(),
    commissionAmount: new Decimal(commissionAmount).toDecimalPlaces(4).toNumber(),
    grossAmount: new Decimal(amount).toDecimalPlaces(4).toNumber(),
    money,
    promotions: promoResult.evaluations,
  };
}
