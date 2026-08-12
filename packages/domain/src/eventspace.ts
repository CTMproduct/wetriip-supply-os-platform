import {
  ADDON_LABELS,
  AddonKind,
  CATERING_ADDONS,
  DomainError,
  EventQuoteRequest,
  EventSpaceAddonDef,
  EventSpaceRate,
  EventQuoteStep,
  LAYOUT_LABELS,
  Layout,
  LayoutCapacity,
} from '@wetriip/contracts';

/**
 * Event space quoting.
 *
 * A fixed pipeline, for the same reason the room pricing pipeline is fixed:
 *
 *   SPACE → SETUP → EQUIPMENT → CATERING → TAX
 *
 * Every line says which step it came from and how it was computed, so a hotel
 * can hand the quote to a client without having to explain it a second time in
 * an email.
 */

export interface QuoteLine {
  step: EventQuoteStep;
  label: string;
  unit: string;
  quantity: number;
  unitAmount: number;
  amount: number;
  explanation: string;
}

export interface EventQuote {
  currency: string;
  layout: Layout;
  pax: number;
  hours: number;
  days: number;
  lines: QuoteLine[];
  spaceTotal: number;
  equipmentTotal: number;
  cateringTotal: number;
  subtotal: number;
  taxTotal: number;
  total: number;
  perPerson: number;
  warnings: string[];
}

export interface EventSpaceSpec {
  id: string;
  name: string;
  currency: string;
  halfDayHours: number;
  fullDayHours: number;
  layouts: LayoutCapacity[];
  rates: EventSpaceRate[];
  addons: EventSpaceAddonDef[];
}

/**
 * Refuse rather than quote a room the group does not fit in.
 *
 * This is the one place a silent success would be worst: the client pays, and
 * discovers on the morning of the event that 80 people cannot sit in a U.
 */
export function assertLayoutFits(space: EventSpaceSpec, layout: Layout, pax: number): LayoutCapacity {
  const cap = space.layouts.find((l) => l.layout === layout);
  if (!cap) {
    throw new DomainError({
      code: 'VALIDATION',
      message: `${space.name} is not set up in ${LAYOUT_LABELS[layout]}.`,
      owner: 'Events',
      remediation: `Available layouts: ${space.layouts
        .map((l) => `${LAYOUT_LABELS[l.layout]} (${l.capacity})`)
        .join(', ')}.`,
      details: { layout, available: space.layouts.map((l) => l.layout) },
    });
  }
  if (pax > cap.capacity) {
    const bigger = space.layouts
      .filter((l) => l.capacity >= pax)
      .sort((a, b) => a.capacity - b.capacity)[0];
    throw new DomainError({
      code: 'VALIDATION',
      message: `${space.name} seats ${cap.capacity} in ${LAYOUT_LABELS[layout]}, not ${pax}.`,
      owner: 'Events',
      remediation: bigger
        ? `${LAYOUT_LABELS[bigger.layout]} would take ${bigger.capacity}.`
        : 'No layout in this room reaches that number — a larger space is needed.',
      details: { layout, capacity: cap.capacity, pax },
    });
  }
  return cap;
}

/**
 * Choose the cheapest honest way to charge for the time asked for.
 *
 * A four-hour booking priced by the hour when a half-day rate is cheaper is how
 * a hotel loses a quote it should have won, so the engine tries every declared
 * unit and takes the lowest — and says which one it picked and what the others
 * would have cost.
 */
export function priceSpaceTime(
  space: EventSpaceSpec,
  hours: number,
  days: number,
  pax: number,
): { line: QuoteLine; considered: string[] } {
  const options: { line: QuoteLine; amount: number }[] = [];

  for (const rate of space.rates) {
    if (rate.unit === 'HOUR') {
      const qty = round2(hours * days);
      options.push({
        amount: round2(rate.amount * qty),
        line: {
          step: 'SPACE',
          label: `${space.name} — por hora`,
          unit: 'HOUR',
          quantity: qty,
          unitAmount: rate.amount,
          amount: round2(rate.amount * qty),
          explanation: `${hours} h × ${days} día(s) × ${fmt(rate.amount)}`,
        },
      });
    }
    if (rate.unit === 'HALF_DAY' && hours <= space.halfDayHours) {
      options.push({
        amount: round2(rate.amount * days),
        line: {
          step: 'SPACE',
          label: `${space.name} — medio día`,
          unit: 'HALF_DAY',
          quantity: days,
          unitAmount: rate.amount,
          amount: round2(rate.amount * days),
          explanation: `${hours} h fits the ${space.halfDayHours} h half day × ${days} día(s)`,
        },
      });
    }
    if (rate.unit === 'FULL_DAY') {
      options.push({
        amount: round2(rate.amount * days),
        line: {
          step: 'SPACE',
          label: `${space.name} — día completo`,
          unit: 'FULL_DAY',
          quantity: days,
          unitAmount: rate.amount,
          amount: round2(rate.amount * days),
          explanation: `${days} día(s) × ${fmt(rate.amount)}`,
        },
      });
    }
    if (rate.unit === 'PER_PERSON') {
      const billable = Math.max(pax, rate.minimumPax);
      options.push({
        amount: round2(rate.amount * billable * days),
        line: {
          step: 'SPACE',
          label: `${space.name} — por persona`,
          unit: 'PER_PERSON',
          quantity: billable * days,
          unitAmount: rate.amount,
          amount: round2(rate.amount * billable * days),
          explanation:
            billable > pax
              ? `${pax} pax billed at the ${rate.minimumPax} minimum × ${days} día(s)`
              : `${pax} pax × ${days} día(s) × ${fmt(rate.amount)}`,
        },
      });
    }
  }

  if (options.length === 0) {
    throw new DomainError({
      code: 'VALIDATION',
      message: `${space.name} has no rate that covers ${hours} h.`,
      owner: 'Events',
      remediation: 'Add an hourly or full-day rate to this space.',
      details: { hours, declared: space.rates.map((r) => r.unit) },
    });
  }

  options.sort((a, b) => a.amount - b.amount);
  const chosen = options[0];
  return {
    line: chosen.line,
    considered: options.map((o) => `${o.line.unit} ${fmt(o.amount)}`),
  };
}

export function quoteEventSpace(args: {
  space: EventSpaceSpec;
  request: EventQuoteRequest;
  taxPct?: number;
}): EventQuote {
  const { space, request } = args;
  const warnings: string[] = [];

  const cap = assertLayoutFits(space, request.layout, request.pax);
  const hours = request.hours ?? space.fullDayHours;
  const days = request.days;

  const lines: QuoteLine[] = [];

  // ── SPACE ──────────────────────────────────────────────
  const timed = priceSpaceTime(space, hours, days, request.pax);
  lines.push(timed.line);
  if (timed.considered.length > 1) {
    warnings.push(`Charged the cheapest applicable unit. Options were: ${timed.considered.join(', ')}.`);
  }

  // ── SETUP ──────────────────────────────────────────────
  if (cap.setupFee > 0) {
    lines.push({
      step: 'SETUP',
      label: `Montaje ${LAYOUT_LABELS[request.layout]}`,
      unit: 'PER_EVENT',
      quantity: days,
      unitAmount: cap.setupFee,
      amount: round2(cap.setupFee * days),
      explanation: `${LAYOUT_LABELS[request.layout]} carries a setup fee × ${days} día(s)`,
    });
  }

  // ── EQUIPMENT and CATERING ─────────────────────────────
  for (const want of request.addons) {
    const def = space.addons.find((a) => a.kind === want.kind);
    if (!def) {
      warnings.push(`${ADDON_LABELS[want.kind]} is not offered in this space and was not quoted.`);
      continue;
    }
    const step: EventQuoteStep = CATERING_ADDONS.includes(want.kind) ? 'CATERING' : 'EQUIPMENT';
    const quantity = addonQuantity(def.unit, want.quantity, { pax: request.pax, hours, days });
    const amount = def.includedInSpace ? 0 : round2(def.amount * quantity);

    lines.push({
      step,
      label: def.name,
      unit: def.unit,
      quantity,
      unitAmount: def.includedInSpace ? 0 : def.amount,
      amount,
      explanation: def.includedInSpace
        ? 'Incluido con el salón'
        : explainAddon(def.unit, quantity, def.amount, { pax: request.pax, hours, days }),
    });
  }

  const by = (s: EventQuoteStep) =>
    round2(lines.filter((l) => l.step === s).reduce((a, l) => a + l.amount, 0));

  const spaceTotal = round2(by('SPACE') + by('SETUP'));
  const equipmentTotal = by('EQUIPMENT');
  const cateringTotal = by('CATERING');
  const subtotal = round2(spaceTotal + equipmentTotal + cateringTotal);

  // ── TAX ────────────────────────────────────────────────
  const taxPct = args.taxPct ?? 0;
  const taxTotal = round2((subtotal * taxPct) / 100);
  if (taxPct > 0) {
    lines.push({
      step: 'TAX',
      label: `Impuestos (${taxPct}%)`,
      unit: 'PER_EVENT',
      quantity: 1,
      unitAmount: taxTotal,
      amount: taxTotal,
      explanation: `${taxPct}% sobre ${fmt(subtotal)}`,
    });
  }

  const total = round2(subtotal + taxTotal);

  return {
    currency: space.currency,
    layout: request.layout,
    pax: request.pax,
    hours,
    days,
    lines,
    spaceTotal,
    equipmentTotal,
    cateringTotal,
    subtotal,
    taxTotal,
    total,
    perPerson: request.pax > 0 ? round2(total / request.pax) : 0,
    warnings,
  };
}

function addonQuantity(
  unit: string,
  requested: number,
  ctx: { pax: number; hours: number; days: number },
): number {
  switch (unit) {
    // Per-person addons default to the whole room; a client asking for 30
    // coffees for 30 people should not have to type 30.
    case 'PER_PERSON':
      return requested > 1 ? requested : ctx.pax;
    case 'PER_HOUR':
      return requested > 1 ? requested : round2(ctx.hours * ctx.days);
    case 'PER_DAY':
      return requested > 1 ? requested : ctx.days;
    default:
      return Math.max(1, requested);
  }
}

function explainAddon(
  unit: string,
  quantity: number,
  amount: number,
  ctx: { pax: number; hours: number; days: number },
): string {
  switch (unit) {
    case 'PER_PERSON':
      return `${quantity} persona(s) × ${fmt(amount)}`;
    case 'PER_HOUR':
      return `${quantity} hora(s) × ${fmt(amount)}`;
    case 'PER_DAY':
      return `${quantity} día(s) × ${fmt(amount)}`;
    default:
      return `${quantity} × ${fmt(amount)}`;
  }
}

/** Which addons a space offers, grouped the way a hotel thinks about them. */
export function addonCatalog(space: EventSpaceSpec): {
  equipment: EventSpaceAddonDef[];
  catering: EventSpaceAddonDef[];
} {
  return {
    equipment: space.addons.filter((a) => !CATERING_ADDONS.includes(a.kind as AddonKind)),
    catering: space.addons.filter((a) => CATERING_ADDONS.includes(a.kind as AddonKind)),
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
