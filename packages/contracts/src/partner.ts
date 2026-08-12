import { z } from 'zod';

/**
 * The demand side, parametrized.
 *
 * A wholesaler is not just a name on a contract. It is a legal entity with a
 * tax identity, a billing address, payment terms and a credit line — and a
 * hotel deciding whether to open inventory to it is making a credit decision as
 * much as a commercial one.
 */
export const PartnerStatusSchema = z.enum(['PENDING', 'ACTIVE', 'ON_HOLD', 'SUSPENDED']);
export type PartnerStatus = z.infer<typeof PartnerStatusSchema>;

export const PaymentTermsSchema = z.enum([
  'PREPAY',
  'NET_7',
  'NET_15',
  'NET_30',
  'NET_45',
  'NET_60',
  'ON_ARRIVAL',
]);
export type PaymentTerms = z.infer<typeof PaymentTermsSchema>;

/**
 * Tax identity schemes we actually encounter. The scheme matters as much as the
 * number: a Colombian NIT and a Mexican RFC have different shapes, different
 * check digits and different invoicing obligations, and storing both as
 * "taxId: string" is how an invoice ends up rejected by a tax authority.
 */
export const TAX_ID_SCHEMES = [
  'NIT',
  'RFC',
  'CUIT',
  'RUC',
  'RUT',
  'CNPJ',
  'VAT',
  'EIN',
  'GST',
  'OTHER',
] as const;
export type TaxIdScheme = (typeof TAX_ID_SCHEMES)[number];

export const PartnerProfileSchema = z
  .object({
    organizationId: z.string().min(1),
    /** Stable and quotable. It appears on bookings and invoices and must not
     *  change once issued. */
    partnerCode: z
      .string()
      .min(3)
      .max(24)
      .regex(/^[A-Z0-9][A-Z0-9-]*$/, 'Uppercase letters, digits and hyphens only'),
    status: PartnerStatusSchema.default('PENDING'),

    legalName: z.string().min(2).max(200),
    taxIdScheme: z.enum(TAX_ID_SCHEMES).nullish(),
    taxId: z.string().max(40).nullish(),
    taxCountry: z.string().length(2).nullish(),

    billingEmail: z.string().email().nullish(),
    billingAddress: z.string().max(300).nullish(),
    billingCity: z.string().max(120).nullish(),
    billingCountry: z.string().length(2).nullish(),
    contactName: z.string().max(160).nullish(),
    contactPhone: z.string().max(50).nullish(),

    /** Markets this partner sells FROM. Drives eligibility and the outbound
     *  and inbound views. */
    sourceMarkets: z.array(z.string().length(2)).default([]),
    iataCode: z.string().max(12).nullish(),
    memberships: z.array(z.string().max(60)).default([]),

    paymentTerms: PaymentTermsSchema.default('PREPAY'),
    currency: z.string().length(3).default('USD'),
    creditLimit: z.number().nonnegative().default(0),
    creditWarningPct: z.number().int().min(10).max(100).default(80),
    notes: z.string().max(2000).nullish(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.taxId && !p.taxIdScheme) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['taxIdScheme'],
        message: 'A tax id without its scheme cannot be validated or invoiced against.',
      });
    }
    // Credit is meaningless without terms that defer payment.
    if (p.creditLimit > 0 && p.paymentTerms === 'PREPAY') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['creditLimit'],
        message: 'A prepay partner cannot hold a credit line. Set payment terms first.',
      });
    }
  });

export type PartnerProfileInput = z.infer<typeof PartnerProfileSchema>;

export interface PartnerProfileRef extends Omit<PartnerProfileInput, 'creditLimit'> {
  id: string;
  tenantId: string;
  organizationName: string;
  organizationType: string;
  creditLimit: number;
  creditUsed: number;
  creditAvailable: number;
  creditUtilizationPct: number;
  /** True when utilization is past the warning threshold but under the limit. */
  creditWarning: boolean;
  onboardedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const CreditEntryTypeSchema = z.enum([
  'HOLD',
  'RELEASE',
  'CHARGE',
  'PAYMENT',
  'ADJUSTMENT',
]);
export type CreditEntryType = z.infer<typeof CreditEntryTypeSchema>;

export interface CreditEntryRef {
  id: string;
  type: CreditEntryType;
  amount: number;
  currency: string;
  balanceAfter: number;
  bookingId: string | null;
  reference: string | null;
  reason: string | null;
  createdAt: string;
}

/** The answer to "can this partner book this?" — with the numbers behind it. */
export interface CreditDecision {
  allowed: boolean;
  reason: string | null;
  requiresPrepay: boolean;
  limit: number;
  used: number;
  available: number;
  requested: number;
  currency: string;
  utilizationAfterPct: number;
  warning: string | null;
}
