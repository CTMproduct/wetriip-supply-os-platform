import { z } from 'zod';
import { ISO_DATE } from './ids';
import { MoneyTrace } from './commercial';
import { PromotionEvaluation } from './promotion';
import { SellabilityResult } from './sellability';

export const SearchRequestSchema = z
  .object({
    destination: z.string().min(2).nullish(),
    propertyIds: z.array(z.string()).default([]),
    checkIn: z.string().regex(ISO_DATE),
    checkOut: z.string().regex(ISO_DATE),
    rooms: z.number().int().min(1).max(30).default(1),
    adults: z.number().int().min(1).max(30).default(2),
    children: z.number().int().min(0).max(20).default(0),
    market: z.string().length(2),
    currency: z.string().length(3),
    channel: z.enum(['B2B', 'B2C', 'MOBILE', 'CORPORATE']).default('B2B'),
    promoCode: z.string().nullish(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.checkIn >= s.checkOut) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['checkOut'],
        message: 'checkOut must be after checkIn',
      });
    }
  });
export type SearchRequestInput = z.infer<typeof SearchRequestSchema>;

/** Every money step, in order, with what produced it. This is the explanation
 *  trace the audit asks for — and the reason the LLM never needs to compute a
 *  price: it only reads the result. */
export interface PriceStep {
  step:
    | 'BASE'
    | 'OCCUPANCY'
    | 'PROMOTION'
    | 'CONTRACT_MARKUP'
    | 'CONTRACT_COMMISSION'
    | 'TAX'
    | 'FEE'
    | 'FX'
    | 'ROUNDING';
  label: string;
  input: number;
  output: number;
  delta: number;
  currency: string;
  detail?: Record<string, unknown>;
}

export interface PriceBreakdown {
  nights: number;
  perNight: Array<{ stayDate: string; amount: number; currency: string }>;
  steps: PriceStep[];
  netAmount: number;
  taxAmount: number;
  feeAmount: number;
  commissionAmount: number;
  grossAmount: number;
  money: MoneyTrace;
  promotions: PromotionEvaluation[];
}

export interface HotelOffer {
  offerId: string;
  propertyId: string;
  propertyName: string;
  propertyCity: string;
  propertyCountry: string;
  roomTypeId: string;
  roomTypeCode: string;
  roomTypeName: string;
  ratePlanId: string;
  ratePlanCode: string;
  ratePlanName: string;
  mealPlan: string;

  checkIn: string;
  checkOut: string;
  nights: number;
  adults: number;
  children: number;

  price: PriceBreakdown;
  cancellation: unknown;
  contractId: string | null;
  promotionIds: string[];

  provenance: {
    ariSource: string;
    ariLayers: string[];
    freshnessSeconds: number;
    mappingVersion: number | null;
    contractVersion: number | null;
    computedAt: string;
  };

  sellability: SellabilityResult;

  /** HMAC over the price-determining fields. A tampered or stale offer cannot
   *  be booked — that is how we avoid selling yesterday's price. */
  signature: string;
  expiresAt: string;
  version: number;
}

export interface SearchResponse {
  searchId: string;
  correlationId: string;
  latencyMs: number;
  offers: HotelOffer[];
  /** Properties that were candidates but did not produce an offer, WITH the
   *  predicate that stopped them. Silence is not an acceptable answer. */
  excluded: Array<{
    propertyId: string;
    propertyName: string;
    reason: string;
    predicates: string[];
  }>;
}
