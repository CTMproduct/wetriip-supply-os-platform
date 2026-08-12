import {
  CONTENT_FIELDS,
  ContentFieldProvenance,
  ContentLayer,
  ContentSourceKind,
  ContentValues,
  EffectiveContent,
  EffectiveImage,
} from '@wetriip/contracts';

/**
 * Effective content engine.
 *
 * External + Managed -> Effective, field by field, MANAGED winning. Identical
 * discipline to Effective ARI and for the same reason: a hotel that corrects
 * its own description and finds it reverted by tonight's import will stop using
 * the extranet.
 *
 * The only asymmetry is images. A description has one value; a gallery is a
 * set. Merging galleries by overwrite would either lose the hotel's own photos
 * or lose the imported ones, so they coexist and the hotel's own sort first.
 */

export interface ContentLayerInput {
  layer: ContentLayer;
  source: ContentSourceKind;
  values: ContentValues;
  updatedAt: Date;
  updatedBy?: string | null;
}

/** Fields a buyer-facing listing genuinely needs. Weighted: a hotel with no
 *  photos is not 90% complete because it filled in a phone number. */
const COMPLETENESS_WEIGHTS: Record<string, number> = {
  descriptionShort: 2,
  descriptionLong: 3,
  addressLine1: 2,
  latitude: 2,
  amenities: 2,
  checkInFrom: 1,
  checkOutBy: 1,
  phone: 1,
  policies: 1,
};
const IMAGE_WEIGHT = 5;
const MIN_IMAGES_FOR_FULL_CREDIT = 6;

export function computeEffectiveContent(args: {
  propertyId: string;
  locale: string;
  layers: ContentLayerInput[];
  images: EffectiveImage[];
  now: Date;
}): EffectiveContent {
  const notes: string[] = [];
  const fields: Record<string, ContentFieldProvenance> = {};
  const layersPresent: ContentLayer[] = [];

  // Lowest precedence first; later layers overwrite earlier ones per field.
  const ordered = [
    ...args.layers.filter((l) => l.layer === 'EXTERNAL'),
    ...args.layers.filter((l) => l.layer === 'MANAGED'),
  ];

  const merged: ContentValues = {};
  for (const layer of ordered) {
    if (!layersPresent.includes(layer.layer)) layersPresent.push(layer.layer);
    for (const field of CONTENT_FIELDS) {
      const value = (layer.values as any)[field];
      // undefined = the layer never mentioned this field. Empty string and
      // empty array are treated the same way: an import that returns "" must
      // not blank out what the hotel wrote.
      if (value === undefined || value === null) continue;
      if (typeof value === 'string' && value.trim() === '') continue;
      if (Array.isArray(value) && value.length === 0) continue;

      (merged as any)[field] = value;
      fields[field] = {
        layer: layer.layer,
        source: layer.source,
        updatedAt: layer.updatedAt.toISOString(),
        updatedBy: layer.updatedBy ?? null,
      };
    }
  }

  const external = ordered.filter((l) => l.layer === 'EXTERNAL');
  const managed = ordered.find((l) => l.layer === 'MANAGED');
  if (external.length && managed) {
    const overridden = CONTENT_FIELDS.filter((f) => fields[f]?.layer === 'MANAGED').length;
    if (overridden > 0) {
      notes.push(
        `${overridden} field(s) are the hotel's own text and take precedence over the imported content. The imported values are preserved underneath.`,
      );
    }
  }
  if (!managed && external.length) {
    notes.push(
      `All content comes from ${external.map((e) => e.source).join(', ')}. Nothing has been written by the hotel yet.`,
    );
  }
  if (!ordered.length) notes.push('No content has been provided for this property in any locale.');

  // ── Completeness ──────────────────────────────────────────
  const missing: string[] = [];
  let earned = 0;
  let total = 0;
  for (const [field, weight] of Object.entries(COMPLETENESS_WEIGHTS)) {
    total += weight;
    const value = (merged as any)[field];
    const present =
      value !== undefined &&
      value !== null &&
      !(typeof value === 'string' && !value.trim()) &&
      !(Array.isArray(value) && value.length === 0);
    if (present) earned += weight;
    else missing.push(field);
  }

  total += IMAGE_WEIGHT;
  const usable = args.images.filter((i) => i.url);
  earned += Math.min(IMAGE_WEIGHT, (usable.length / MIN_IMAGES_FOR_FULL_CREDIT) * IMAGE_WEIGHT);
  if (usable.length === 0) missing.push('images');
  else if (usable.length < MIN_IMAGES_FOR_FULL_CREDIT) {
    notes.push(
      `${usable.length} image(s). Buyer-facing listings convert poorly under ${MIN_IMAGES_FOR_FULL_CREDIT}.`,
    );
  }
  if (!usable.some((i) => i.isHero)) {
    notes.push('No hero image is set, so the listing will pick one arbitrarily.');
  }

  return {
    propertyId: args.propertyId,
    locale: args.locale,
    values: merged,
    explanation: { fields, layersPresent, notes },
    completeness: total > 0 ? Math.round((earned / total) * 100) / 100 : 0,
    missing,
    images: sortImages(usable),
    updatedAt: args.now.toISOString(),
  };
}

/**
 * Gallery order: hero first, then the hotel's own photos, then imported ones,
 * then by category priority and explicit position.
 *
 * The hotel's own images sort ahead of imported ones on purpose — they are the
 * ones it chose, and they are the ones whose licence we are certain of.
 */
const CATEGORY_PRIORITY: Record<string, number> = {
  EXTERIOR: 0,
  VIEW: 1,
  ROOM: 2,
  POOL: 3,
  BEACH: 4,
  LOBBY: 5,
  RESTAURANT: 6,
  SPA: 7,
  BATHROOM: 8,
  MEETING: 9,
  OTHER: 10,
};

export function sortImages(images: EffectiveImage[]): EffectiveImage[] {
  return [...images].sort((a, b) => {
    if (a.isHero !== b.isHero) return a.isHero ? -1 : 1;
    if (a.layer !== b.layer) return a.layer === 'MANAGED' ? -1 : 1;
    const ca = CATEGORY_PRIORITY[a.category] ?? 99;
    const cb = CATEGORY_PRIORITY[b.category] ?? 99;
    if (ca !== cb) return ca - cb;
    return a.position - b.position;
  });
}

/**
 * Imported images carry someone else's copyright. Publishing them without
 * knowing the terms is a real legal exposure, so an EXTERNAL image without a
 * credit and a licence is held back rather than shown.
 */
export function imagesSafeToPublish(images: EffectiveImage[]): {
  publishable: EffectiveImage[];
  withheld: Array<{ id: string; reason: string }>;
} {
  const publishable: EffectiveImage[] = [];
  const withheld: Array<{ id: string; reason: string }> = [];

  for (const image of images) {
    if (image.layer === 'MANAGED') {
      publishable.push(image);
      continue;
    }
    if (!image.credit || !image.licence) {
      withheld.push({
        id: image.id,
        reason: `Imported from ${image.source} without ${!image.credit ? 'a credit' : 'a licence'}. Not publishable until the terms are recorded.`,
      });
      continue;
    }
    publishable.push(image);
  }

  return { publishable, withheld };
}
