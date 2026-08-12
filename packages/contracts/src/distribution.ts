import { z } from 'zod';

/**
 * Distribution policy — who may see this hotel at all.
 *
 * Deliberately separate from a contract. A contract says "these are our terms
 * with this buyer". A distribution policy says "this hotel is open to the
 * marketplace" or "only to Viatur and two others, and only for the US and UK".
 *
 * The hotel owns it, and it is evaluated BEFORE any contract is considered.
 * Folding it into contracts would mean a hotel could only restrict distribution
 * by refusing to sign, which is not the same thing at all.
 */
export const DistributionModeSchema = z.enum([
  'MARKETPLACE_OPEN',
  'SELECTED_PARTNERS',
  'CLOSED',
]);
export type DistributionMode = z.infer<typeof DistributionModeSchema>;

export const DistributionPolicySchema = z
  .object({
    mode: DistributionModeSchema,
    allowedMarkets: z.array(z.string().length(2)).default([]),
    blockedMarkets: z.array(z.string().length(2)).default([]),
    allowedPartnerIds: z.array(z.string()).default([]),
    blockedPartnerIds: z.array(z.string()).default([]),
    allowedPartnerTypes: z
      .array(z.enum(['WHOLESALER', 'AGENCY', 'OTA', 'CORPORATE', 'DMC', 'TOUR_OPERATOR']))
      .default([]),
    allowedChannels: z.array(z.enum(['B2B', 'B2C', 'MOBILE', 'CORPORATE'])).default([]),
    minAdvanceDays: z.number().int().min(0).max(730).nullish(),
    maxAdvanceDays: z.number().int().min(0).max(730).nullish(),
    minLos: z.number().int().min(1).max(365).nullish(),
    floorRate: z.number().nonnegative().nullish(),
    floorCurrency: z.string().length(3).nullish(),
    requiresApproval: z.boolean().default(false),
    note: z.string().max(1000).nullish(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.mode === 'SELECTED_PARTNERS' && p.allowedPartnerIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowedPartnerIds'],
        message:
          'SELECTED_PARTNERS with an empty allow list would hide the hotel from everyone. Use CLOSED if that is the intent.',
      });
    }
    const overlap = p.allowedMarkets.filter((m) => p.blockedMarkets.includes(m));
    if (overlap.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blockedMarkets'],
        message: `Markets appear in both allow and block lists: ${overlap.join(', ')}.`,
      });
    }
    if (p.floorRate != null && !p.floorCurrency) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['floorCurrency'],
        message: 'A floor rate without a currency cannot be enforced.',
      });
    }
    if (p.minAdvanceDays != null && p.maxAdvanceDays != null && p.minAdvanceDays > p.maxAdvanceDays) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxAdvanceDays'],
        message: 'maxAdvanceDays must be at least minAdvanceDays.',
      });
    }
  });

export type DistributionPolicyInput = z.infer<typeof DistributionPolicySchema>;

export interface DistributionPolicyRef extends DistributionPolicyInput {
  id: string;
  propertyId: string;
  version: number;
  updatedBy: string | null;
  updatedAt: string;
}

/** Who is asking, evaluated against the policy. */
export interface DistributionRequest {
  organizationId: string;
  organizationType: string;
  market: string;
  channel: string;
  checkIn: string;
  nights: number;
  /** Net rate the buyer would be offered, in the policy floor currency. */
  netRate?: number | null;
  netRateCurrency?: string | null;
  now: Date;
}

export interface DistributionDecision {
  allowed: boolean;
  mode: DistributionMode;
  /** Every rule that was evaluated, so a hotel can see why a partner is or is
   *  not seeing it without opening a support ticket. */
  checks: Array<{
    code:
      | 'MODE'
      | 'PARTNER_BLOCKED'
      | 'PARTNER_ALLOWED'
      | 'PARTNER_TYPE'
      | 'MARKET_BLOCKED'
      | 'MARKET_ALLOWED'
      | 'CHANNEL'
      | 'ADVANCE_WINDOW'
      | 'MIN_LOS'
      | 'FLOOR_RATE';
    label: string;
    passed: boolean;
    detail?: string;
  }>;
  deniedBy: string[];
  reason: string | null;
}
