import { z } from 'zod';

/**
 * Property content.
 *
 * Photos, descriptions, amenities, address, policies — everything that makes a
 * hotel a hotel rather than a row of prices.
 *
 * It carries the SAME layering as ARI, and for the same reason: an import must
 * never silently overwrite what a hotel wrote about itself. A hotel that fixes
 * its own description and finds it reverted by tonight's feed will never trust
 * the extranet again.
 *
 *   EXTERNAL  what a content source said
 *   MANAGED   what the hotel wrote
 *   Effective computed field by field, MANAGED winning, with provenance
 */
export const ContentLayerSchema = z.enum(['EXTERNAL', 'MANAGED']);
export type ContentLayer = z.infer<typeof ContentLayerSchema>;

export const ContentSourceKindSchema = z.enum([
  'MANUAL',
  'CANONICAL_JSON',
  'BOOKING',
  'EXPEDIA',
  'GIATA',
  'GIMMONIX',
  'CHANNEL_MANAGER',
]);
export type ContentSourceKind = z.infer<typeof ContentSourceKindSchema>;

export const ImageCategorySchema = z.enum([
  'EXTERIOR',
  'LOBBY',
  'ROOM',
  'BATHROOM',
  'RESTAURANT',
  'POOL',
  'SPA',
  'MEETING',
  'BEACH',
  'VIEW',
  'OTHER',
]);
export type ImageCategory = z.infer<typeof ImageCategorySchema>;

/**
 * Amenity codes are a controlled vocabulary, not free text. "Wi-Fi", "WIFI",
 * "wifi gratis" and "Internet inalámbrico" are the same fact, and a buyer
 * filtering on it needs them to be one value.
 */
export const AMENITY_CODES = [
  'WIFI',
  'WIFI_FREE',
  'PARKING',
  'PARKING_FREE',
  'POOL',
  'POOL_HEATED',
  'BEACH_ACCESS',
  'SPA',
  'GYM',
  'RESTAURANT',
  'BAR',
  'ROOM_SERVICE',
  'BREAKFAST_INCLUDED',
  'AIR_CONDITIONING',
  'PETS_ALLOWED',
  'AIRPORT_SHUTTLE',
  'BUSINESS_CENTER',
  'MEETING_ROOMS',
  'LAUNDRY',
  'ACCESSIBLE',
  'ELEVATOR',
  'SAFE',
  'MINIBAR',
  'KITCHEN',
  'FAMILY_ROOMS',
  'NON_SMOKING',
  'EV_CHARGING',
  'CONCIERGE',
  'TERRACE',
  'GARDEN',
] as const;
export type AmenityCode = (typeof AMENITY_CODES)[number];

export const ContentValuesSchema = z.object({
  descriptionShort: z.string().max(500).nullish(),
  descriptionLong: z.string().max(20000).nullish(),
  highlights: z.array(z.string().max(200)).max(12).nullish(),

  addressLine1: z.string().max(300).nullish(),
  addressLine2: z.string().max(300).nullish(),
  postalCode: z.string().max(30).nullish(),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  phone: z.string().max(50).nullish(),
  email: z.string().email().nullish(),
  website: z.string().url().nullish(),

  checkInFrom: z.string().regex(/^\d{2}:\d{2}$/).nullish(),
  checkInTo: z.string().regex(/^\d{2}:\d{2}$/).nullish(),
  checkOutBy: z.string().regex(/^\d{2}:\d{2}$/).nullish(),

  amenities: z.array(z.enum(AMENITY_CODES)).nullish(),
  policies: z
    .object({
      pets: z.string().max(1000).nullish(),
      children: z.string().max(1000).nullish(),
      smoking: z.string().max(1000).nullish(),
      extraBeds: z.string().max(1000).nullish(),
      payment: z.string().max(1000).nullish(),
    })
    .nullish(),
});
export type ContentValues = z.infer<typeof ContentValuesSchema>;

export const CONTENT_FIELDS = Object.keys(ContentValuesSchema.shape) as (keyof ContentValues)[];

export const UpdateContentSchema = z
  .object({
    locale: z.string().min(2).max(10).default('es'),
    values: ContentValuesSchema,
    reason: z.string().max(500).nullish(),
  })
  .strict();
export type UpdateContentInput = z.infer<typeof UpdateContentSchema>;

export const ImageInputSchema = z
  .object({
    url: z.string().url(),
    thumbnailUrl: z.string().url().nullish(),
    caption: z.string().max(300).nullish(),
    category: ImageCategorySchema.default('OTHER'),
    roomTypeId: z.string().nullish(),
    width: z.number().int().positive().nullish(),
    height: z.number().int().positive().nullish(),
    position: z.number().int().min(0).default(0),
    isHero: z.boolean().default(false),
    /** Required for anything not shot by the hotel. See ContentImage docs. */
    credit: z.string().max(200).nullish(),
    licence: z.string().max(200).nullish(),
  })
  .strict();
export type ImageInput = z.infer<typeof ImageInputSchema>;

export interface ContentFieldProvenance {
  layer: ContentLayer;
  source: ContentSourceKind;
  updatedAt: string;
  updatedBy?: string | null;
}

export interface EffectiveContent {
  propertyId: string;
  locale: string;
  values: ContentValues;
  /** Field-by-field: who set this value and when. */
  explanation: {
    fields: Record<string, ContentFieldProvenance>;
    layersPresent: ContentLayer[];
    notes: string[];
  };
  /** 0..1. What a buyer-facing listing would consider complete. */
  completeness: number;
  missing: string[];
  images: EffectiveImage[];
  updatedAt: string;
}

export interface EffectiveImage {
  id: string;
  url: string;
  thumbnailUrl: string | null;
  caption: string | null;
  category: ImageCategory;
  roomTypeId: string | null;
  position: number;
  isHero: boolean;
  layer: ContentLayer;
  source: ContentSourceKind;
  credit: string | null;
  licence: string | null;
}

/**
 * A content feed. Same shape of contract as a channel manager adapter, and the
 * same certification discipline: a source that is not certified declares no
 * capability and fails loudly rather than returning an empty hotel.
 */
export interface ContentSourceCapabilities {
  fetchProfile: boolean;
  fetchImages: boolean;
  fetchRoomContent: boolean;
  /** Whether the provider allows us to store and redistribute what it returns.
   *  This is a legal fact, not a technical one, and it decides whether the
   *  integration may exist at all. */
  redistributionPermitted: boolean;
  requiresPropertyOwnedCredentials: boolean;
  authScheme: 'NONE' | 'API_KEY' | 'OAUTH2' | 'BASIC' | 'MTLS';
}

export interface ContentFetchResult {
  values: ContentValues;
  images: ImageInput[];
  sourceReference: string | null;
  sourceUpdatedAt: string | null;
  raw?: unknown;
}

export interface ContentSourceStatus {
  propertyId: string;
  kind: ContentSourceKind;
  displayName: string;
  enabled: boolean;
  certified: boolean;
  capabilities: ContentSourceCapabilities;
  lastSyncAt: string | null;
  lastSyncOk: boolean | null;
  lastSyncDetail: string | null;
  /** What has to be true before this source can be switched on. */
  requirements: string[];
}
