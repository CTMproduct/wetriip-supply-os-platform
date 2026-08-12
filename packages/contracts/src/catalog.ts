import { z } from 'zod';

export const PropertyStatusSchema = z.enum(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SUSPENDED']);
export type PropertyStatus = z.infer<typeof PropertyStatusSchema>;

export interface PropertyRef {
  id: string;
  tenantId: string;
  organizationId: string;
  code: string;
  name: string;
  city: string;
  country: string;
  timezone: string;
  currency: string;
  status: PropertyStatus;
}

export interface RoomTypeRef {
  id: string;
  propertyId: string;
  code: string;
  name: string;
  maxOccupancy: number;
  maxAdults: number;
  maxChildren: number;
  quantity: number;
  active: boolean;
}

export interface RatePlanRef {
  id: string;
  propertyId: string;
  code: string;
  name: string;
  mealPlan: string;
  currency: string;
  source: 'EXTERNAL' | 'MANAGED';
  refundable: boolean;
  active: boolean;
}

export interface TaxRuleRef {
  id: string;
  propertyId: string;
  code: string;
  name: string;
  mode: 'PERCENTAGE' | 'FIXED_PER_NIGHT' | 'FIXED_PER_STAY';
  value: number;
  currency: string | null;
  included: boolean;
}

/**
 * A mapping is never a loose pair of strings. It belongs to a version that was
 * created, reviewed, published and can be rolled back — the audit rated a wrong
 * room/rate mapping as a P1 risk precisely because unversioned mappings cannot
 * be diffed or reverted.
 */
export const MappingEntrySchema = z.object({
  entityType: z.enum(['PROPERTY', 'ROOM_TYPE', 'RATE_PLAN']),
  remoteCode: z.string().min(1),
  remoteName: z.string().nullish(),
  localPropertyId: z.string().nullish(),
  localRoomTypeId: z.string().nullish(),
  localRatePlanId: z.string().nullish(),
});
export type MappingEntryInput = z.infer<typeof MappingEntrySchema>;

export interface ResolvedMapping {
  version: number;
  propertyId: string;
  /** remoteCode -> local id */
  roomTypes: Record<string, string>;
  ratePlans: Record<string, string>;
}
