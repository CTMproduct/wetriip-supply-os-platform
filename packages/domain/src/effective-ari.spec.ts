import { computeEffectiveAri, mergeLayerValues } from './effective-ari';

const key = {
  tenantId: 't1',
  propertyId: 'p1',
  roomTypeId: 'r1',
  ratePlanId: 'rp1',
  stayDate: '2026-09-15',
  occupancy: 2,
};

const now = new Date('2026-09-01T12:00:00Z');

describe('Effective ARI', () => {
  it('keeps the external value when there is no managed override', () => {
    const row = computeEffectiveAri({
      key,
      external: {
        layer: 'EXTERNAL',
        values: { baseAmount: 650000, currency: 'COP', available: 5, open: true },
        source: 'SITEMINDER',
        sourceTimestamp: new Date('2026-09-01T11:30:00Z'),
        version: 3,
      },
      now,
      freshnessSlaSeconds: 3600,
    });

    expect(row.baseAmount).toBe(650000);
    expect(row.explanation.fields.baseAmount.layer).toBe('EXTERNAL');
    expect(row.explanation.fields.baseAmount.source).toBe('SITEMINDER');
  });

  it('lets a managed override win field-by-field without erasing the external layer', () => {
    const row = computeEffectiveAri({
      key,
      external: {
        layer: 'EXTERNAL',
        values: { baseAmount: 650000, currency: 'COP', available: 5, open: true, minLos: 1 },
        source: 'SITEMINDER',
        sourceTimestamp: new Date('2026-09-01T11:30:00Z'),
        version: 3,
      },
      managed: {
        layer: 'MANAGED',
        // Only minLos is overridden; price must still come from the supplier.
        values: { minLos: 3 },
        source: 'USER:melisa',
        sourceTimestamp: new Date('2026-09-01T11:45:00Z'),
        version: 1,
      },
      now,
      freshnessSlaSeconds: 3600,
    });

    expect(row.minLos).toBe(3);
    expect(row.explanation.fields.minLos.layer).toBe('MANAGED');
    expect(row.baseAmount).toBe(650000);
    expect(row.explanation.fields.baseAmount.layer).toBe('EXTERNAL');
    expect(row.explanation.layersPresent).toEqual(['EXTERNAL', 'MANAGED']);
  });

  it('ignores a managed override whose validity window does not cover the stay date', () => {
    const row = computeEffectiveAri({
      key,
      external: {
        layer: 'EXTERNAL',
        values: { baseAmount: 650000, currency: 'COP', available: 5, open: true, minLos: 1 },
        source: 'SITEMINDER',
        sourceTimestamp: new Date('2026-09-01T11:30:00Z'),
        version: 3,
      },
      managed: {
        layer: 'MANAGED',
        values: { minLos: 3 },
        source: 'USER:melisa',
        sourceTimestamp: new Date('2026-09-01T11:45:00Z'),
        version: 1,
        validFrom: new Date('2026-10-01T00:00:00Z'),
        validTo: new Date('2026-10-31T00:00:00Z'),
      },
      now,
      freshnessSlaSeconds: 3600,
    });

    expect(row.minLos).toBe(1);
    expect(row.explanation.notes.join(' ')).toMatch(/outside its validity window/);
  });

  it('treats stop-sell as a veto over open', () => {
    const row = computeEffectiveAri({
      key,
      external: {
        layer: 'EXTERNAL',
        values: { open: true, stopSell: true, available: 4 },
        source: 'CM',
        sourceTimestamp: now,
        version: 1,
      },
      now,
      freshnessSlaSeconds: 3600,
    });

    expect(row.open).toBe(false);
    expect(row.explanation.notes.join(' ')).toMatch(/stop-sell wins/);
  });

  it('measures freshness against the external layer only', () => {
    // A human override must never make a dead supplier feed look alive.
    const row = computeEffectiveAri({
      key,
      external: {
        layer: 'EXTERNAL',
        values: { baseAmount: 1000, currency: 'COP' },
        source: 'CM',
        sourceTimestamp: new Date('2026-08-30T12:00:00Z'),
        version: 1,
      },
      managed: {
        layer: 'MANAGED',
        values: { baseAmount: 1200 },
        source: 'USER:melisa',
        sourceTimestamp: now,
        version: 1,
      },
      now,
      freshnessSlaSeconds: 3600,
    });

    expect(row.stale).toBe(true);
    expect(row.freshnessSeconds).toBeGreaterThan(3600);
    expect(row.baseAmount).toBe(1200);
  });

  it('reports never-received inventory distinctly from stale inventory', () => {
    const row = computeEffectiveAri({ key, now, freshnessSlaSeconds: 3600 });
    expect(row.stale).toBe(true);
    expect(row.freshnessSeconds).toBe(-1);
    expect(row.explanation.notes.join(' ')).toMatch(/has ever been received/);
  });
});

describe('mergeLayerValues', () => {
  it('leaves untouched fields alone when a partial update arrives', () => {
    const merged = mergeLayerValues(
      { baseAmount: 100, available: 5, open: true },
      { baseAmount: 120 },
    );
    expect(merged).toEqual({ baseAmount: 120, available: 5, open: true });
  });

  it('honours an explicit null as a clear', () => {
    const merged = mergeLayerValues({ maxLos: 7 }, { maxLos: null });
    expect(merged.maxLos).toBeNull();
  });
});
