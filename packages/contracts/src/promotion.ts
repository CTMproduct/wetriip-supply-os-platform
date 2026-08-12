import { z } from 'zod';
import { ISO_DATE } from './ids';

/**
 * Promotion rule DSL.
 *
 * Promotions are data, not code paths. A new promotion type must be expressible
 * here or it does not exist — that is what keeps the pricing pipeline
 * deterministic and lets the agent propose a promotion without anyone shipping
 * a release.
 */
export const PromotionTypeSchema = z.enum([
  'PERCENTAGE',
  'FIXED',
  'EARLY_BOOKING',
  'LAST_MINUTE',
  'MIN_LOS',
  'MAX_LOS',
  'STAY_X_PAY_Y',
  'MOBILE',
  'GEO',
  'AGENCY_EXCLUSIVE',
  'MARKET_EXCLUSIVE',
  'DAY_OF_WEEK',
  'ROOM_SPECIFIC',
  'RATE_PLAN_SPECIFIC',
  'PACKAGE',
  'CLOSED_USER_GROUP',
  'VOLUME',
  'PROMO_CODE',
]);
export type PromotionType = z.infer<typeof PromotionTypeSchema>;

export const DiscountSchema = z.object({
  type: z.enum(['PERCENTAGE', 'FIXED', 'FREE_NIGHTS']),
  value: z.number().nonnegative().default(0),
  currency: z.string().length(3).nullish(),
  /** STAY_X_PAY_Y: stay `stayNights`, pay `payNights`. */
  stayNights: z.number().int().min(2).nullish(),
  payNights: z.number().int().min(1).nullish(),
});
export type Discount = z.infer<typeof DiscountSchema>;

export const PromotionDefinitionSchema = z
  .object({
    type: PromotionTypeSchema,

    scope: z
      .object({
        propertyId: z.string().min(1),
        roomTypeCodes: z.array(z.string()).nullish(),
        ratePlanCodes: z.array(z.string()).nullish(),
      })
      .strict(),

    audience: z
      .object({
        markets: z.array(z.string().length(2)).nullish(),
        organizationIds: z.array(z.string()).nullish(),
        channels: z.array(z.enum(['B2B', 'B2C', 'MOBILE', 'CORPORATE'])).nullish(),
        closedUserGroup: z.string().nullish(),
        promoCode: z.string().nullish(),
      })
      .strict()
      .default({}),

    bookingWindow: z
      .object({
        minAdvanceDays: z.number().int().min(0).max(730).nullish(),
        maxAdvanceDays: z.number().int().min(0).max(730).nullish(),
        from: z.string().regex(ISO_DATE).nullish(),
        to: z.string().regex(ISO_DATE).nullish(),
      })
      .strict()
      .default({}),

    stayWindow: z
      .object({
        from: z.string().regex(ISO_DATE),
        to: z.string().regex(ISO_DATE),
        /** 0 = Sunday. Applied per night, not per arrival. */
        daysOfWeek: z.array(z.number().int().min(0).max(6)).nullish(),
      })
      .strict(),

    los: z
      .object({ min: z.number().int().min(1).nullish(), max: z.number().int().min(1).nullish() })
      .strict()
      .default({}),

    occupancy: z
      .object({
        minAdults: z.number().int().min(1).nullish(),
        maxAdults: z.number().int().min(1).nullish(),
      })
      .strict()
      .default({}),

    discount: DiscountSchema,

    stacking: z
      .object({ allowed: z.boolean().default(false), priority: z.number().int().default(100) })
      .strict()
      .default({ allowed: false, priority: 100 }),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.stayWindow.from > d.stayWindow.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stayWindow'],
        message: 'stayWindow.from must be on or before stayWindow.to',
      });
    }
    if (d.discount.type === 'PERCENTAGE' && d.discount.value > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['discount', 'value'],
        message: 'percentage discount cannot exceed 100',
      });
    }
    if (d.discount.type === 'FREE_NIGHTS') {
      if (!d.discount.stayNights || !d.discount.payNights) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['discount'],
          message: 'FREE_NIGHTS requires stayNights and payNights',
        });
      } else if (d.discount.payNights >= d.discount.stayNights) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['discount'],
          message: 'payNights must be lower than stayNights',
        });
      }
    }
    if (d.discount.type === 'FIXED' && !d.discount.currency) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['discount', 'currency'],
        message: 'FIXED discount requires a currency',
      });
    }
  });

export type PromotionDefinition = z.infer<typeof PromotionDefinitionSchema>;

export const PromotionStatusSchema = z.enum([
  'DRAFT',
  'PENDING_APPROVAL',
  'ACTIVE',
  'PAUSED',
  'EXPIRED',
  'CANCELLED',
]);
export type PromotionStatus = z.infer<typeof PromotionStatusSchema>;

export interface PromotionRef {
  id: string;
  tenantId: string;
  propertyId: string;
  code: string;
  name: string;
  type: PromotionType;
  status: PromotionStatus;
  version: number;
  definition: PromotionDefinition;
  priority: number;
  stackable: boolean;
  validFrom: string;
  validTo: string;
}

/** Why a promotion did or did not apply — surfaced in the offer explanation. */
export interface PromotionEvaluation {
  promotionId: string;
  code: string;
  name: string;
  eligible: boolean;
  reasons: string[];
  discountAmount: number;
  priority: number;
  stackable: boolean;
  applied: boolean;
}
