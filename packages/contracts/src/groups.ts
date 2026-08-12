import { z } from 'zod';
import { ISO_DATE } from './ids';

/**
 * Groups — block inventory, benefits, and the negotiation that settles a price.
 *
 * Group business is not transient business with a bigger number. Three things
 * are structurally different, and each one is why this cannot be modelled as a
 * multi-room booking:
 *
 *  1. **Inventory is declared, not derived.** A hotel sets aside a block. The
 *     twin/double split matters because the same physical room is made up
 *     differently, so per-bedding maxima and a physical ceiling are two separate
 *     constraints — a block of 20 rooms can legitimately offer "up to 18 twin"
 *     and "up to 20 double" at the same time.
 *  2. **Price is negotiated, not published.** The agency arrives with a budget,
 *     not a search. Rounds are append-only and each carries an expiry.
 *  3. **Benefits are contractual.** "One free per twenty" is arithmetic the
 *     hotel parametrises once and both sides must be able to reproduce.
 */

export const BeddingSchema = z.enum(['SINGLE', 'TWIN', 'DOUBLE', 'TRIPLE', 'QUAD']);
export type Bedding = z.infer<typeof BeddingSchema>;

export const BEDDING_LABELS: Record<Bedding, string> = {
  SINGLE: 'Sencilla',
  TWIN: 'Twin (dos camas)',
  DOUBLE: 'Doble (una cama)',
  TRIPLE: 'Triple',
  QUAD: 'Cuádruple',
};

/** How many people a bedding sleeps. Used to check a group actually fits. */
export const BEDDING_PAX: Record<Bedding, number> = {
  SINGLE: 1,
  TWIN: 2,
  DOUBLE: 2,
  TRIPLE: 3,
  QUAD: 4,
};

export const GroupBlockStatusSchema = z.enum(['DRAFT', 'OPEN', 'CLOSED', 'EXPIRED']);
export type GroupBlockStatus = z.infer<typeof GroupBlockStatusSchema>;

const stayDate = z.string().regex(ISO_DATE, 'Expected yyyy-mm-dd');

export const GroupBlockLineSchema = z.object({
  roomTypeId: z.string(),
  bedding: BeddingSchema,
  /** Maximum rooms this line may contribute. */
  roomsTotal: z.number().int().min(0).max(2000),
  /** Nightly rate for the block, in the block currency. Null = negotiate it. */
  ratePerNight: z.number().nonnegative().nullable().default(null),
});
export type GroupBlockLine = z.infer<typeof GroupBlockLineSchema>;

export const UpsertGroupBlockSchema = z
  .object({
    propertyId: z.string(),
    code: z.string().min(2).max(40),
    name: z.string().min(2).max(160),
    from: stayDate,
    to: stayDate,
    currency: z.string().length(3),
    /**
     * The physical cap across every line. A block whose lines sum higher is not
     * a mistake — the same rooms convert between twin and double — but the
     * ceiling is what may actually be sold.
     */
    roomsCeiling: z.number().int().min(1).max(2000),
    /** Days before arrival when unsold block rooms return to transient. */
    releaseDays: z.number().int().min(0).max(365).default(30),
    minRooms: z.number().int().min(1).max(2000).default(1),
    lines: z.array(GroupBlockLineSchema).min(1),
    status: GroupBlockStatusSchema.default('DRAFT'),
    notes: z.string().max(2000).nullable().default(null),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.to < v.from) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'The block ends before it starts' });
    }
    const seen = new Set<string>();
    for (const l of v.lines) {
      const key = `${l.roomTypeId}|${l.bedding}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['lines'],
          message: `Duplicate line for ${l.bedding} in the same room type`,
        });
      }
      seen.add(key);
      if (l.roomsTotal > v.roomsCeiling) {
        ctx.addIssue({
          code: 'custom',
          path: ['lines'],
          message: `A line offers ${l.roomsTotal} rooms but the block ceiling is ${v.roomsCeiling}`,
        });
      }
    }
    if (v.minRooms > v.roomsCeiling) {
      ctx.addIssue({
        code: 'custom',
        path: ['minRooms'],
        message: 'The minimum is above the block ceiling',
      });
    }
  });
export type UpsertGroupBlock = z.infer<typeof UpsertGroupBlockSchema>;

/* ── Benefits ────────────────────────────────────────────── */

export const CompBasisSchema = z.enum(['PER_NIGHT', 'PER_STAY']);
export type CompBasis = z.infer<typeof CompBasisSchema>;

export const GroupBenefitKindSchema = z.enum([
  'COMP_ROOM',
  'TOUR_LEADER_FREE',
  'UPGRADE',
  'EARLY_CHECK_IN',
  'LATE_CHECK_OUT',
  'WELCOME_DRINK',
  'MEETING_ROOM_HOURS',
  'PORTERAGE',
  'CUSTOM',
]);
export type GroupBenefitKind = z.infer<typeof GroupBenefitKindSchema>;

export const GROUP_BENEFIT_LABELS: Record<GroupBenefitKind, string> = {
  COMP_ROOM: 'Habitación gratuita',
  TOUR_LEADER_FREE: 'Tour leader gratis',
  UPGRADE: 'Upgrade de categoría',
  EARLY_CHECK_IN: 'Early check-in',
  LATE_CHECK_OUT: 'Late check-out',
  WELCOME_DRINK: 'Cóctel de bienvenida',
  MEETING_ROOM_HOURS: 'Horas de salón incluidas',
  PORTERAGE: 'Maletero incluido',
  CUSTOM: 'Otro beneficio',
};

export const GroupBenefitSchema = z.object({
  kind: GroupBenefitKindSchema,
  /** Grant one unit of this benefit for every N paid rooms. */
  everyNRooms: z.number().int().min(1).max(500),
  /** Never grant more than this, whatever the arithmetic says. Null = uncapped. */
  maxUnits: z.number().int().min(1).max(500).nullable().default(null),
  /** Whether the count restarts each night or applies once for the stay. */
  basis: CompBasisSchema.default('PER_STAY'),
  description: z.string().max(300).nullable().default(null),
});
export type GroupBenefit = z.infer<typeof GroupBenefitSchema>;

export const SetGroupPolicySchema = z
  .object({
    propertyId: z.string(),
    /** Rooms below this never qualify as a group. */
    minRoomsForGroup: z.number().int().min(2).max(500).default(10),
    /** The lowest nightly rate this hotel will consider for group business. */
    floorRatePerNight: z.number().nonnegative().nullable().default(null),
    floorCurrency: z.string().length(3).nullable().default(null),
    /**
     * Refuse a bid under the floor without a human ever seeing it. Off by
     * default: a hotel usually wants to know somebody asked.
     */
    autoDeclineBelowFloor: z.boolean().default(false),
    /** Hours an agency's offer stays live before it lapses. */
    responseWindowHours: z.number().int().min(1).max(168).default(24),
    depositPct: z.number().min(0).max(100).default(30),
    cancellationPolicy: z.string().max(2000).nullable().default(null),
    benefits: z.array(GroupBenefitSchema).max(20).default([]),
    notifyEmails: z.array(z.string().email()).max(10).default([]),
    /** E.164, e.g. +573001234567. */
    notifyWhatsapp: z
      .array(z.string().regex(/^\+[1-9]\d{7,14}$/, 'Use E.164, e.g. +573001234567'))
      .max(5)
      .default([]),
  })
  .strict();
export type SetGroupPolicy = z.infer<typeof SetGroupPolicySchema>;

/* ── The negotiation ─────────────────────────────────────── */

export const GroupRequestStatusSchema = z.enum([
  'OPEN',
  'COUNTERED',
  'ACCEPTED',
  'DECLINED',
  'EXPIRED',
  'WITHDRAWN',
]);
export type GroupRequestStatus = z.infer<typeof GroupRequestStatusSchema>;

export const GROUP_REQUEST_STATUS_LABELS: Record<GroupRequestStatus, string> = {
  OPEN: 'Esperando al hotel',
  COUNTERED: 'Contraoferta enviada',
  ACCEPTED: 'Aceptada',
  DECLINED: 'Rechazada',
  EXPIRED: 'Vencida',
  WITHDRAWN: 'Retirada por la agencia',
};

export const GroupRoomRequestSchema = z.object({
  bedding: BeddingSchema,
  rooms: z.number().int().min(1).max(2000),
});
export type GroupRoomRequest = z.infer<typeof GroupRoomRequestSchema>;

/**
 * What an agency sends. The defining field is `budgetTotal`: the agency is not
 * asking for a price, it is stating the money it has. Everything downstream
 * exists to answer "does that clear our floor?" in a way both sides can check.
 */
export const CreateGroupRequestSchema = z
  .object({
    propertyId: z.string(),
    blockId: z.string().nullable().default(null),
    groupName: z.string().min(2).max(160),
    checkIn: stayDate,
    checkOut: stayDate,
    pax: z.number().int().min(1).max(5000),
    rooms: z.array(GroupRoomRequestSchema).min(1),
    budgetTotal: z.number().positive(),
    currency: z.string().length(3),
    /** Meals, meeting space, transfers — priced separately, stated here. */
    inclusions: z.array(z.string().max(120)).max(20).default([]),
    notes: z.string().max(2000).nullable().default(null),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.checkOut <= v.checkIn) {
      ctx.addIssue({ code: 'custom', path: ['checkOut'], message: 'Check-out must follow check-in' });
    }
  });
export type CreateGroupRequest = z.infer<typeof CreateGroupRequestSchema>;

export const BidActorSchema = z.enum(['AGENCY', 'HOTEL']);
export type BidActor = z.infer<typeof BidActorSchema>;

export const RespondGroupRequestSchema = z
  .object({
    requestId: z.string(),
    decision: z.enum(['ACCEPT', 'COUNTER', 'DECLINE']),
    /** Required for COUNTER: the total the hotel will accept. */
    counterTotal: z.number().positive().nullable().default(null),
    /** Optional per-benefit sweetener attached to a counter. */
    benefitsOffered: z.array(GroupBenefitSchema).max(10).default([]),
    message: z.string().max(2000).nullable().default(null),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.decision === 'COUNTER' && v.counterTotal == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['counterTotal'],
        message: 'A counter-offer must state the amount the hotel will accept',
      });
    }
    if (v.decision !== 'COUNTER' && v.counterTotal != null) {
      ctx.addIssue({
        code: 'custom',
        path: ['counterTotal'],
        message: 'Only a counter-offer carries an amount',
      });
    }
  });
export type RespondGroupRequest = z.infer<typeof RespondGroupRequestSchema>;

/* ── Notifications ───────────────────────────────────────── */

export const NotificationChannelSchema = z.enum(['EMAIL', 'WHATSAPP']);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

export const NotificationStatusSchema = z.enum([
  'PENDING',
  'SENT',
  'FAILED',
  /** No provider is configured. Recorded honestly rather than reported as sent. */
  'NOT_CONFIGURED',
]);
export type NotificationStatus = z.infer<typeof NotificationStatusSchema>;

export const NOTIFICATION_TEMPLATES = [
  'group.request.received',
  'group.request.countered',
  'group.request.accepted',
  'group.request.declined',
  'group.request.expiring',
  'group.request.expired',
] as const;
export type NotificationTemplate = (typeof NOTIFICATION_TEMPLATES)[number];
