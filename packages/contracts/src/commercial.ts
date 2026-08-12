import { z } from 'zod';
import { ISO_DATE } from './ids';

export const PaymentModelSchema = z.enum(['NET', 'COMMISSION', 'PREPAID']);
export type PaymentModel = z.infer<typeof PaymentModelSchema>;

export const ContractStatusSchema = z.enum([
  'DRAFT',
  'PENDING_APPROVAL',
  'PUBLISHED',
  'SUSPENDED',
  'EXPIRED',
]);
export type ContractStatus = z.infer<typeof ContractStatusSchema>;

export const CancellationPolicySchema = z.object({
  /** Free cancellation until N days before check-in. */
  freeUntilDays: z.number().int().min(0).max(365).default(0),
  penaltyType: z.enum(['NONE', 'FIRST_NIGHT', 'PERCENTAGE', 'FULL']).default('FIRST_NIGHT'),
  penaltyValue: z.number().nonnegative().default(0),
  nonRefundable: z.boolean().default(false),
});
export type CancellationPolicy = z.infer<typeof CancellationPolicySchema>;

export const ContractDefinitionSchema = z
  .object({
    code: z.string().min(2),
    name: z.string().min(2),
    supplierOrgId: z.string().min(1),
    buyerOrgId: z.string().min(1),
    validFrom: z.string().regex(ISO_DATE),
    validTo: z.string().regex(ISO_DATE),
    currency: z.string().length(3),
    paymentModel: PaymentModelSchema,
    commissionPct: z.number().min(0).max(60).default(0),
    markupPct: z.number().min(0).max(200).default(0),
    creditLimit: z.number().nonnegative().nullish(),
    markets: z.array(z.string().length(2)).default([]),
    channels: z.array(z.enum(['B2B', 'B2C', 'MOBILE', 'CORPORATE'])).default(['B2B']),
    propertyIds: z.array(z.string()).default([]),
    cancellationPolicy: CancellationPolicySchema.nullish(),
    promotionPermissions: z
      .object({
        canCreate: z.boolean().default(false),
        canStack: z.boolean().default(false),
        maxDiscountPct: z.number().min(0).max(100).default(100),
      })
      .default({}),
    distributionPermissions: z
      .object({
        canResell: z.boolean().default(false),
        allowedChannels: z.array(z.string()).default([]),
        blockedMarkets: z.array(z.string().length(2)).default([]),
      })
      .default({}),
    /** Chains deeper than this produce margin explosion and rate leakage. */
    maxResaleDepth: z.number().int().min(1).max(2).default(2),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.validFrom > c.validTo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['validTo'],
        message: 'validTo must be on or after validFrom',
      });
    }
    if (c.supplierOrgId === c.buyerOrgId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['buyerOrgId'],
        message: 'supplier and buyer must be different organizations',
      });
    }
  });

export type ContractDefinition = z.infer<typeof ContractDefinitionSchema>;

export interface ContractRef {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  supplierOrgId: string;
  buyerOrgId: string;
  status: ContractStatus;
  version: number;
  validFrom: string;
  validTo: string;
  currency: string;
  paymentModel: PaymentModel;
  commissionPct: number;
  markupPct: number;
  markets: string[];
  channels: string[];
  propertyIds: string[];
  cancellationPolicy: CancellationPolicy | null;
  maxResaleDepth: number;
}

/** Currency provenance. USD is a reporting lens, never a replacement. */
export interface FxQuote {
  from: string;
  to: string;
  rate: number;
  source: string;
  timestamp: string;
}

export interface MoneyTrace {
  supplierCurrency: string;
  supplierAmount: number;
  normalizedCurrency: string;
  normalizedAmount: number;
  buyerCurrency: string;
  buyerAmount: number;
  fx: FxQuote;
}
