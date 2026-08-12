import { z } from 'zod';

/**
 * Booking state machine.
 *
 * UNKNOWN is a real state, not an error path. A supplier timeout does not mean
 * the supplier did nothing — it means we do not know yet. Collapsing UNKNOWN
 * into FAILED is how platforms create double bookings.
 */
export const BookingStatusSchema = z.enum([
  'DRAFT',
  'PENDING',
  'UNKNOWN',
  'CONFIRMED',
  'REJECTED',
  'CANCEL_PENDING',
  'CANCELLED',
  'MANUAL_REVIEW',
]);
export type BookingStatus = z.infer<typeof BookingStatusSchema>;

export const BOOKING_TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  DRAFT: ['PENDING'],
  PENDING: ['CONFIRMED', 'REJECTED', 'UNKNOWN'],
  UNKNOWN: ['CONFIRMED', 'REJECTED', 'MANUAL_REVIEW'],
  CONFIRMED: ['CANCEL_PENDING', 'MANUAL_REVIEW'],
  CANCEL_PENDING: ['CANCELLED', 'CONFIRMED', 'MANUAL_REVIEW'],
  CANCELLED: [],
  REJECTED: [],
  MANUAL_REVIEW: ['CONFIRMED', 'CANCELLED', 'REJECTED'],
};

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return BOOKING_TRANSITIONS[from].includes(to);
}

export const GuestSchema = z
  .object({
    name: z.string().min(2),
    email: z.string().email().nullish(),
    phone: z.string().nullish(),
  })
  .strict();

export const CreateBookingSchema = z
  .object({
    offerId: z.string().min(1),
    /** Required. Retries without it are refused rather than gambled on. */
    idempotencyKey: z.string().min(8),
    guest: GuestSchema,
    adults: z.number().int().min(1).max(30),
    children: z.number().int().min(0).max(20).default(0),
    notes: z.string().nullish(),
  })
  .strict();
export type CreateBookingInput = z.infer<typeof CreateBookingSchema>;

export interface BookingTimelineEntry {
  at: string;
  from: BookingStatus | null;
  to: BookingStatus;
  actor: string;
  reason?: string;
  correlationId: string;
  detail?: Record<string, unknown>;
}

export interface BookingRef {
  id: string;
  reference: string;
  status: BookingStatus;
  propertyId: string;
  buyerOrgId: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  guestName: string;
  amount: number;
  currencyCode: string;
  supplierReference: string | null;
  timeline: BookingTimelineEntry[];
  createdAt: string;
}
