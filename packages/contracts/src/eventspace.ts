import { z } from 'zod';

/**
 * Meeting and event space.
 *
 * A salón is not a room type. It is sold by TIME (hour, half day, full day) or
 * by HEAD (delegate packages), its capacity depends on how the chairs are
 * arranged, and half its revenue is in equipment and catering attached to it.
 * Forcing it through the ARI model would produce a rate per night for something
 * nobody rents per night.
 *
 * The layout is the load-bearing detail. The same room seats 120 in theatre and
 * 28 in U-shape, so a quote that ignores the layout is a quote that will be
 * wrong on site — which is why capacity is declared per layout and a request
 * that does not fit is refused with the number it would have needed.
 */

export const LayoutSchema = z.enum([
  'THEATRE',
  'CLASSROOM',
  'U_SHAPE',
  'L_SHAPE',
  'BOARDROOM',
  'IMPERIAL',
  'BANQUET',
  'COCKTAIL',
  'CABARET',
]);
export type Layout = z.infer<typeof LayoutSchema>;

export const LAYOUT_LABELS: Record<Layout, string> = {
  THEATRE: 'Auditorio',
  CLASSROOM: 'Escuela',
  U_SHAPE: 'En U',
  L_SHAPE: 'En L',
  BOARDROOM: 'Junta',
  IMPERIAL: 'Imperial',
  BANQUET: 'Banquete',
  COCKTAIL: 'Cóctel',
  CABARET: 'Cabaré',
};

export const RateUnitSchema = z.enum(['HOUR', 'HALF_DAY', 'FULL_DAY', 'PER_PERSON']);
export type RateUnit = z.infer<typeof RateUnitSchema>;

export const RATE_UNIT_LABELS: Record<RateUnit, string> = {
  HOUR: 'Por hora',
  HALF_DAY: 'Medio día',
  FULL_DAY: 'Día completo',
  PER_PERSON: 'Por persona',
};

/** Hours a half day and a full day are taken to mean, unless the hotel says otherwise. */
export const DEFAULT_HALF_DAY_HOURS = 4;
export const DEFAULT_FULL_DAY_HOURS = 8;

export const AddonUnitSchema = z.enum(['PER_EVENT', 'PER_HOUR', 'PER_DAY', 'PER_PERSON']);
export type AddonUnit = z.infer<typeof AddonUnitSchema>;

export const ADDON_UNIT_LABELS: Record<AddonUnit, string> = {
  PER_EVENT: 'Por evento',
  PER_HOUR: 'Por hora',
  PER_DAY: 'Por día',
  PER_PERSON: 'Por persona',
};

/** The equipment and catering hotels actually get asked for, named so the
 *  assistant can map "con videobeam y coffee break" onto something typed. */
export const AddonKindSchema = z.enum([
  'MICROPHONE',
  'WIRELESS_MICROPHONE',
  'VIDEOBEAM',
  'SCREEN',
  'SOUND_SYSTEM',
  'LECTERN',
  'FLIPCHART',
  'WIFI_DEDICATED',
  'STREAMING',
  'TECHNICIAN',
  'STAGE',
  'COFFEE_BREAK',
  'COFFEE_BREAK_PREMIUM',
  'BREAKFAST',
  'LUNCH',
  'DINNER',
  'OPEN_BAR',
  'HYDRATION_STATION',
  'CUSTOM',
]);
export type AddonKind = z.infer<typeof AddonKindSchema>;

export const ADDON_LABELS: Record<AddonKind, string> = {
  MICROPHONE: 'Micrófono alámbrico',
  WIRELESS_MICROPHONE: 'Micrófono inalámbrico',
  VIDEOBEAM: 'Videobeam',
  SCREEN: 'Pantalla',
  SOUND_SYSTEM: 'Sonido',
  LECTERN: 'Podio',
  FLIPCHART: 'Papelógrafo',
  WIFI_DEDICATED: 'WiFi dedicado',
  STREAMING: 'Transmisión en vivo',
  TECHNICIAN: 'Técnico de apoyo',
  STAGE: 'Tarima',
  COFFEE_BREAK: 'Coffee break',
  COFFEE_BREAK_PREMIUM: 'Coffee break premium',
  BREAKFAST: 'Desayuno',
  LUNCH: 'Almuerzo',
  DINNER: 'Cena',
  OPEN_BAR: 'Barra libre',
  HYDRATION_STATION: 'Estación de hidratación',
  CUSTOM: 'Otro servicio',
};

/** Catering is a per-head decision and equipment is not; the quote groups them
 *  separately so a hotel can see food cost against room cost at a glance. */
export const CATERING_ADDONS: AddonKind[] = [
  'COFFEE_BREAK',
  'COFFEE_BREAK_PREMIUM',
  'BREAKFAST',
  'LUNCH',
  'DINNER',
  'OPEN_BAR',
  'HYDRATION_STATION',
];

export const LayoutCapacitySchema = z.object({
  layout: LayoutSchema,
  capacity: z.number().int().min(1).max(10000),
  /** Some layouts cost more to set up (banquet rounds, cabaret). */
  setupFee: z.number().nonnegative().default(0),
});
export type LayoutCapacity = z.infer<typeof LayoutCapacitySchema>;

export const EventSpaceRateSchema = z.object({
  unit: RateUnitSchema,
  amount: z.number().nonnegative(),
  /** Below this many people a PER_PERSON rate still charges the minimum. */
  minimumPax: z.number().int().min(0).max(10000).default(0),
});
export type EventSpaceRate = z.infer<typeof EventSpaceRateSchema>;

export const EventSpaceAddonSchema = z.object({
  kind: AddonKindSchema,
  name: z.string().min(2).max(120),
  unit: AddonUnitSchema,
  amount: z.number().nonnegative(),
  /** Included at no charge with the room — priced at zero but still listed, so
   *  the client can see what they are getting rather than guess. */
  includedInSpace: z.boolean().default(false),
  description: z.string().max(400).nullable().default(null),
});
export type EventSpaceAddonDef = z.infer<typeof EventSpaceAddonSchema>;

export const UpsertEventSpaceSchema = z
  .object({
    propertyId: z.string(),
    code: z.string().min(2).max(40),
    name: z.string().min(2).max(160),
    currency: z.string().length(3),
    areaM2: z.number().positive().max(100000).nullable().default(null),
    ceilingHeightM: z.number().positive().max(50).nullable().default(null),
    naturalLight: z.boolean().default(false),
    divisible: z.boolean().default(false),
    floor: z.string().max(40).nullable().default(null),
    halfDayHours: z.number().int().min(1).max(24).default(DEFAULT_HALF_DAY_HOURS),
    fullDayHours: z.number().int().min(1).max(24).default(DEFAULT_FULL_DAY_HOURS),
    layouts: z.array(LayoutCapacitySchema).min(1),
    rates: z.array(EventSpaceRateSchema).min(1),
    addons: z.array(EventSpaceAddonSchema).max(40).default([]),
    active: z.boolean().default(true),
    notes: z.string().max(2000).nullable().default(null),
  })
  .strict()
  .superRefine((v, ctx) => {
    const layouts = new Set<string>();
    for (const l of v.layouts) {
      if (layouts.has(l.layout)) {
        ctx.addIssue({ code: 'custom', path: ['layouts'], message: `Duplicate layout ${l.layout}` });
      }
      layouts.add(l.layout);
    }
    const units = new Set<string>();
    for (const r of v.rates) {
      if (units.has(r.unit)) {
        ctx.addIssue({ code: 'custom', path: ['rates'], message: `Duplicate rate for ${r.unit}` });
      }
      units.add(r.unit);
    }
    if (v.halfDayHours >= v.fullDayHours) {
      ctx.addIssue({
        code: 'custom',
        path: ['halfDayHours'],
        message: 'A half day must be shorter than a full day',
      });
    }
  });
export type UpsertEventSpace = z.infer<typeof UpsertEventSpaceSchema>;

/* ── Quoting ─────────────────────────────────────────────── */

export const EventQuoteRequestSchema = z
  .object({
    spaceId: z.string(),
    date: z.string(),
    layout: LayoutSchema,
    pax: z.number().int().min(1).max(10000),
    /** Null means "price it by the day", which is what most enquiries mean. */
    hours: z.number().min(0.5).max(24).nullable().default(null),
    days: z.number().int().min(1).max(30).default(1),
    addons: z
      .array(
        z.object({
          kind: AddonKindSchema,
          /** Servings, units or hours depending on the addon's own unit. */
          quantity: z.number().min(0).max(10000).default(1),
        }),
      )
      .max(40)
      .default([]),
  })
  .strict();
export type EventQuoteRequest = z.infer<typeof EventQuoteRequestSchema>;

export const EVENT_QUOTE_STEPS = ['SPACE', 'SETUP', 'EQUIPMENT', 'CATERING', 'TAX'] as const;
export type EventQuoteStep = (typeof EVENT_QUOTE_STEPS)[number];
