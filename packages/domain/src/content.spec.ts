import { EffectiveImage } from '@wetriip/contracts';
import { ContentLayerInput, computeEffectiveContent, imagesSafeToPublish, sortImages } from './content';

const now = new Date('2026-09-01T12:00:00Z');

function image(over: Partial<EffectiveImage> = {}): EffectiveImage {
  return {
    id: `i${Math.random()}`,
    url: 'https://example.test/a.jpg',
    thumbnailUrl: null,
    caption: null,
    category: 'OTHER',
    roomTypeId: null,
    position: 0,
    isHero: false,
    layer: 'MANAGED',
    source: 'MANUAL',
    credit: null,
    licence: null,
    ...over,
  };
}

const external: ContentLayerInput = {
  layer: 'EXTERNAL',
  source: 'GIATA',
  updatedAt: new Date('2026-08-01T00:00:00Z'),
  values: {
    descriptionShort: 'Imported description',
    descriptionLong: 'Imported long description',
    addressLine1: 'Imported address',
    amenities: ['WIFI'],
  },
};

const managed: ContentLayerInput = {
  layer: 'MANAGED',
  source: 'MANUAL',
  updatedAt: new Date('2026-08-20T00:00:00Z'),
  updatedBy: 'melisa',
  values: { descriptionShort: 'What the hotel actually wrote' },
};

describe('Effective content', () => {
  it('lets the hotel own text win field by field without erasing the import', () => {
    const c = computeEffectiveContent({
      propertyId: 'p1',
      locale: 'es',
      layers: [external, managed],
      images: [],
      now,
    });

    expect(c.values.descriptionShort).toBe('What the hotel actually wrote');
    expect(c.explanation.fields.descriptionShort.layer).toBe('MANAGED');
    // The imported long description is untouched and still in effect.
    expect(c.values.descriptionLong).toBe('Imported long description');
    expect(c.explanation.fields.descriptionLong.layer).toBe('EXTERNAL');
  });

  it('never lets an empty imported value blank out what the hotel wrote', () => {
    const emptyImport: ContentLayerInput = {
      ...external,
      values: { descriptionShort: '   ', amenities: [] },
    };
    const c = computeEffectiveContent({
      propertyId: 'p1',
      locale: 'es',
      layers: [emptyImport, managed],
      images: [],
      now,
    });
    expect(c.values.descriptionShort).toBe('What the hotel actually wrote');
  });

  it('scores completeness against what a listing actually needs', () => {
    const empty = computeEffectiveContent({
      propertyId: 'p1',
      locale: 'es',
      layers: [],
      images: [],
      now,
    });
    expect(empty.completeness).toBe(0);
    expect(empty.missing).toContain('images');

    const full = computeEffectiveContent({
      propertyId: 'p1',
      locale: 'es',
      layers: [
        {
          layer: 'MANAGED',
          source: 'MANUAL',
          updatedAt: now,
          values: {
            descriptionShort: 'a',
            descriptionLong: 'b',
            addressLine1: 'c',
            latitude: 10,
            amenities: ['WIFI'],
            checkInFrom: '15:00',
            checkOutBy: '12:00',
            phone: '+57',
            policies: { pets: 'no' },
          },
        },
      ],
      images: Array.from({ length: 6 }, () => image()),
      now,
    });
    expect(full.completeness).toBe(1);
    expect(full.missing).toEqual([]);
  });

  it('warns when a gallery is too thin to convert', () => {
    const c = computeEffectiveContent({
      propertyId: 'p1',
      locale: 'es',
      layers: [managed],
      images: [image()],
      now,
    });
    expect(c.explanation.notes.join(' ')).toMatch(/convert poorly under/);
  });

  it('notes when no hero image is set', () => {
    const c = computeEffectiveContent({
      propertyId: 'p1',
      locale: 'es',
      layers: [managed],
      images: [image(), image()],
      now,
    });
    expect(c.explanation.notes.join(' ')).toMatch(/No hero image/);
  });
});

describe('Image licensing', () => {
  it('publishes the hotel own images without conditions', () => {
    const { publishable, withheld } = imagesSafeToPublish([image({ layer: 'MANAGED' })]);
    expect(publishable).toHaveLength(1);
    expect(withheld).toHaveLength(0);
  });

  it('withholds an imported image with no credit or licence', () => {
    const { publishable, withheld } = imagesSafeToPublish([
      image({ layer: 'EXTERNAL', source: 'GIATA' }),
    ]);
    expect(publishable).toHaveLength(0);
    expect(withheld[0].reason).toMatch(/without a credit/);
  });

  it('publishes an imported image once its terms are recorded', () => {
    const { publishable } = imagesSafeToPublish([
      image({ layer: 'EXTERNAL', source: 'GIATA', credit: 'Hotel', licence: 'CC-BY' }),
    ]);
    expect(publishable).toHaveLength(1);
  });
});

describe('Gallery order', () => {
  it('puts the hero first, then the hotel own photos, then imported ones', () => {
    const sorted = sortImages([
      image({ id: 'imported', layer: 'EXTERNAL', category: 'EXTERIOR' }),
      image({ id: 'own', layer: 'MANAGED', category: 'ROOM' }),
      image({ id: 'hero', layer: 'EXTERNAL', isHero: true }),
    ]);
    expect(sorted.map((i) => i.id)).toEqual(['hero', 'own', 'imported']);
  });
});
