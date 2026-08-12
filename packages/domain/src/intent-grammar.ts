import { StructuredCommand, StructuredCommandSchema, addDays, toStayDate } from '@wetriip/contracts';

/**
 * Deterministic intent grammar (Spanish + English).
 *
 * This is not a fallback bolted on for when the API key is missing — it is a
 * design position. The platform must be able to run, be tested and be
 * certified without a model in the loop, because the model is the one part of
 * the chain we cannot unit-test to a fixed answer.
 *
 * When an LLM IS configured it produces the same StructuredCommand type and
 * goes through the same policy, simulation, confirmation and audit path. The
 * grammar is also the regression harness the LLM is measured against.
 */

export interface IntentContext {
  now: Date;
  propertyId?: string | null;
  roomTypeCode?: string | null;
  ratePlanCode?: string | null;
  selectedDates?: string[] | null;
  market?: string | null;
  defaultCurrency?: string | null;
}

export interface IntentParseResult {
  matched: boolean;
  command?: StructuredCommand;
  intent: string;
  confidence: number;
  /** Why the grammar could not build a command. Shown to the user verbatim —
   *  "I did not understand" is never an acceptable answer on its own. */
  reason?: string;
  missing?: string[];
}

const MONTHS: Record<string, number> = {
  enero: 1, january: 1, jan: 1, ene: 1,
  febrero: 2, february: 2, feb: 2,
  marzo: 3, march: 3, mar: 3,
  abril: 4, april: 4, abr: 4, apr: 4,
  mayo: 5, may: 5,
  junio: 6, june: 6, jun: 6,
  julio: 7, july: 7, jul: 7,
  agosto: 8, august: 8, ago: 8, aug: 8,
  septiembre: 9, setiembre: 9, september: 9, sep: 9, sept: 9,
  octubre: 10, october: 10, oct: 10,
  noviembre: 11, november: 11, nov: 11,
  diciembre: 12, december: 12, dic: 12, dec: 12,
};

const COUNTRY_ALIASES: Record<string, string> = {
  mexico: 'MX', mexicano: 'MX', mexicanos: 'MX',
  colombia: 'CO', colombiano: 'CO', colombianos: 'CO',
  peru: 'PE', chile: 'CL', argentina: 'AR', brasil: 'BR', brazil: 'BR',
  ecuador: 'EC', panama: 'PA', 'estados unidos': 'US', usa: 'US',
  espana: 'ES', spain: 'ES', canada: 'CA',
};

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Date range extraction. Returns null when nothing recognizable is present —
 * we never guess a window, because guessing "this month" on a rate change is
 * how you discount a quarter you meant to leave alone.
 */
export function extractDateRange(
  text: string,
  now: Date,
): { from: string; to: string; label: string } | null {
  const t = normalize(text);
  const year = now.getUTCFullYear();

  // ISO explicit: "2026-09-01 al 2026-09-30"
  const iso = t.match(/(\d{4}-\d{2}-\d{2})\s*(?:al|a|to|-|hasta|until)\s*(\d{4}-\d{2}-\d{2})/);
  if (iso) return { from: iso[1], to: iso[2], label: `${iso[1]} to ${iso[2]}` };

  // "del 1 al 30 de septiembre" / "from 1 to 30 september"
  const dayRange = t.match(
    /(?:del|de|from)?\s*(\d{1,2})\s*(?:al|a|to|-|hasta)\s*(\d{1,2})\s*(?:de\s+)?([a-z]+)/,
  );
  if (dayRange && MONTHS[dayRange[3]]) {
    const m = MONTHS[dayRange[3]];
    const y = m < now.getUTCMonth() + 1 ? year + 1 : year;
    return {
      from: `${y}-${pad(m)}-${pad(Number(dayRange[1]))}`,
      to: `${y}-${pad(m)}-${pad(Number(dayRange[2]))}`,
      label: `${dayRange[1]}-${dayRange[2]} ${dayRange[3]}`,
    };
  }

  // Whole month: "septiembre" / "in september"
  for (const [name, m] of Object.entries(MONTHS)) {
    if (name.length < 3) continue;
    if (new RegExp(`\\b${name}\\b`).test(t)) {
      const y = m < now.getUTCMonth() + 1 ? year + 1 : year;
      return {
        from: `${y}-${pad(m)}-01`,
        to: `${y}-${pad(m)}-${pad(lastDayOfMonth(y, m))}`,
        label: name,
      };
    }
  }

  // Named seasons that matter commercially.
  if (/\bnavidad|christmas|fin de ano|new year|nochevieja\b/.test(t)) {
    const y = now.getUTCMonth() + 1 === 12 ? year : year;
    return { from: `${y}-12-24`, to: `${y + 1}-01-02`, label: 'Christmas / New Year' };
  }
  if (/semana santa|holy week|easter/.test(t)) return null; // moves yearly; refuse to guess

  // Relative windows
  const nextDays = t.match(/(?:proximos|next|siguientes)\s+(\d{1,3})\s*(?:dias|days)/);
  if (nextDays) {
    const from = toStayDate(now);
    return { from, to: addDays(from, Number(nextDays[1])), label: `next ${nextDays[1]} days` };
  }
  if (/\beste fin de semana|this weekend\b/.test(t)) {
    const from = toStayDate(now);
    const dow = new Date(`${from}T00:00:00Z`).getUTCDay();
    const toFri = (5 - dow + 7) % 7;
    return { from: addDays(from, toFri), to: addDays(from, toFri + 2), label: 'this weekend' };
  }

  return null;
}

export function extractPercent(text: string): number | null {
  const m = normalize(text).match(/(-?\d{1,3}(?:[.,]\d+)?)\s*(?:%|por ciento|percent)/);
  if (!m) return null;
  return Number(m[1].replace(',', '.'));
}

export function extractMarkets(text: string): string[] {
  const t = normalize(text);
  const found = new Set<string>();
  for (const [name, code] of Object.entries(COUNTRY_ALIASES)) {
    if (new RegExp(`\\b${name}\\b`).test(t)) found.add(code);
  }
  const iso = t.match(/\bmercado\s+([a-z]{2})\b/);
  if (iso) found.add(iso[1].toUpperCase());
  return [...found];
}

export function extractAdvanceDays(text: string): number | null {
  const t = normalize(text);

  // "30 dias de anticipacion" / "30 days in advance"
  const explicit = t.match(
    /(?:minimo\s+)?(\d{1,3})\s*dias?\s*(?:de\s*)?(?:anticipacion|antelacion|antes)|(\d{1,3})\s*days?\s*(?:in\s*)?advance/,
  );
  if (explicit) return Number(explicit[1] ?? explicit[2]);

  // "early booking 45 dias" — the phrase already means advance purchase, so the
  // number next to it is the window. Requiring "de anticipacion" here made the
  // grammar drop a request people actually make.
  const nearEarlyBooking = t.match(
    /(?:early\s*booking|reserva\s*anticipada|compra\s*anticipada)\D{0,12}(\d{1,3})\s*(?:dias?|days?)?/,
  );
  if (nearEarlyBooking) return Number(nearEarlyBooking[1]);

  const afterNumber = t.match(/(\d{1,3})\s*(?:dias?|days?)\s*(?:early\s*booking|antes)/);
  if (afterNumber) return Number(afterNumber[1]);

  return null;
}

export function extractNights(text: string): number | null {
  const t = normalize(text);
  const m = t.match(/(\d{1,2})\s*noches?|(\d{1,2})\s*nights?/);
  return m ? Number(m[1] ?? m[2]) : null;
}

const DIRECTION_UP = /\b(sube|subir|aumenta|incrementa|raise|increase|up)\b/;
const DIRECTION_DOWN = /\b(baja|bajar|reduce|reducir|disminuye|lower|decrease|cut|down)\b/;

export function parseIntent(utterance: string, ctx: IntentContext): IntentParseResult {
  const t = normalize(utterance);
  const propertyId = ctx.propertyId ?? null;

  const needProperty = (intent: string): IntentParseResult => ({
    matched: false,
    intent,
    confidence: 0.4,
    reason:
      'I understood the action but not which property it applies to. Open a property or name it explicitly.',
    missing: ['propertyId'],
  });

  // ── GROUPS AND EVENT SPACE ────────────────────────────────

  if (/(solicitud|solicitudes|peticion|request).*(grupo|group)|grupos pendientes|group requests/.test(t)) {
    if (!propertyId) return needProperty('list_group_requests');
    const status = /pendiente|abierta|open/.test(t)
      ? 'OPEN'
      : /aceptad|accepted/.test(t)
        ? 'ACCEPTED'
        : /vencid|expired/.test(t)
          ? 'EXPIRED'
          : null;
    return build('list_group_requests', { kind: 'list_group_requests', propertyId, status });
  }

  if (/(salon|salones|sala de eventos|event space|meeting room)/.test(t) && !/(configura|carga|crea|registra|parametriza|añade|anade|agrega)/.test(t)) {
    if (!propertyId) return needProperty('get_event_spaces');
    return build('get_event_spaces', { kind: 'get_event_spaces', propertyId });
  }

  // "Una gratuidad por cada 20 habitaciones" — the single most common group
  // term in the region, and the reason this grammar exists in Spanish first.
  const comp = extractCompRule(t);
  const floor = extractGroupFloor(t);
  const window = extractResponseWindow(t);
  if (comp || floor || window) {
    if (!propertyId) return needProperty('set_group_policy');
    return build('set_group_policy', {
      kind: 'set_group_policy',
      propertyId,
      minRoomsForGroup: extractMinGroupRooms(t),
      floorRatePerNight: floor?.amount ?? null,
      floorCurrency: floor?.currency ?? ctx.defaultCurrency ?? null,
      responseWindowHours: window,
      depositPct: extractDepositPct(t),
      benefits: comp ? [comp] : null,
      reason: null,
    });
  }

  // Answering an agency. Deliberately requires an explicit id in the utterance:
  // "acepta el grupo" with no reference is exactly the ambiguity that must not
  // resolve to whichever request happens to be first.
  const groupRef = /\b(?:grupo|group|solicitud|request)\s+([a-z0-9]{6,32})\b/.exec(t);
  if (groupRef && /(acepta|aceptar|accept|rechaza|rechazar|decline|contraoferta|contraofertar|counter)/.test(t)) {
    const decision = /(acepta|aceptar|accept)/.test(t)
      ? 'ACCEPT'
      : /(rechaza|rechazar|decline)/.test(t)
        ? 'DECLINE'
        : 'COUNTER';
    const amount = extractPlainAmount(t);
    if (decision === 'COUNTER' && amount == null) {
      return {
        matched: false,
        intent: 'respond_group_request',
        confidence: 0.5,
        reason: 'A counter-offer needs the amount the hotel will accept. Say the figure.',
        missing: ['counterTotal'],
      };
    }
    return build('respond_group_request', {
      kind: 'respond_group_request',
      requestId: groupRef[1],
      decision,
      counterTotal: decision === 'COUNTER' ? amount : null,
      message: null,
    });
  }

  // ── READ ──────────────────────────────────────────────────
  if (/por que no (estoy )?(vendo|vendiendo|vende)|why am i not selling|no vendo|not selling/.test(t)) {
    if (!propertyId) return needProperty('explain_no_sales');
    const range = extractDateRange(t, ctx.now);
    const markets = extractMarkets(t);
    return build('explain_no_sales', {
      kind: 'explain_no_sales',
      propertyId,
      from: range?.from ?? null,
      to: range?.to ?? null,
      market: markets[0] ?? ctx.market ?? null,
    });
  }

  if (/salud (del )?ari|ari health|estado del ari/.test(t)) {
    if (!propertyId) return needProperty('get_ari_health');
    const range = extractDateRange(t, ctx.now);
    return build('get_ari_health', {
      kind: 'get_ari_health',
      propertyId,
      from: range?.from ?? null,
      to: range?.to ?? null,
    });
  }

  if (/conectividad|channel manager|conexiones|connectivity/.test(t) && !/promo/.test(t)) {
    return build('get_connectivity_health', {
      kind: 'get_connectivity_health',
      propertyId: propertyId ?? null,
    });
  }

  if (/(que|cual|cuales|mis|listar|list|muestra|show).*(promocion|promotion)/.test(t)) {
    if (!propertyId) return needProperty('list_promotions');
    return build('list_promotions', { kind: 'list_promotions', propertyId });
  }

  if (/disponibilidad|availability|cuantas habitaciones|how many rooms/.test(t) && !DIRECTION_UP.test(t) && !DIRECTION_DOWN.test(t)) {
    if (!propertyId) return needProperty('get_availability');
    const range = extractDateRange(t, ctx.now) ?? defaultRange(ctx);
    if (!range)
      return {
        matched: false,
        intent: 'get_availability',
        confidence: 0.5,
        reason: 'Which dates? Say a range such as "from 20 to 30 September".',
        missing: ['dateRange'],
      };
    return build('get_availability', {
      kind: 'get_availability',
      propertyId,
      from: range.from,
      to: range.to,
      roomTypeCodes: ctx.roomTypeCode ? [ctx.roomTypeCode] : null,
    });
  }

  // ── UNDO ──────────────────────────────────────────────────
  const undo = t.match(/(?:deshaz|revierte|rollback|undo)\s*(?:la accion|action)?\s*([a-z0-9_-]{6,})?/);
  if (undo) {
    if (!undo[1])
      return {
        matched: false,
        intent: 'rollback_action',
        confidence: 0.5,
        reason: 'Which action should I roll back? Pick one from the audit trail.',
        missing: ['actionId'],
      };
    return build('rollback_action', { kind: 'rollback_action', actionId: undo[1], reason: utterance });
  }

  // ── PROMOTION ─────────────────────────────────────────────
  if (/(crea|crear|arma|nueva|create|add|lanza)\s.*(promocion|promotion|descuento|discount|early booking)/.test(t)) {
    if (!propertyId) return needProperty('create_promotion');
    const pctValue = extractPercent(t);
    const range = extractDateRange(t, ctx.now);
    const advance = extractAdvanceDays(t);
    const markets = extractMarkets(t);
    const minLos = /minimo|min los|at least/.test(t) ? extractNights(t) : null;

    const missing: string[] = [];
    if (pctValue == null) missing.push('discount');
    if (!range) missing.push('stayWindow');
    if (missing.length) {
      return {
        matched: false,
        intent: 'create_promotion',
        confidence: 0.6,
        reason:
          missing.includes('discount') && missing.includes('stayWindow')
            ? 'I need the discount and the stay dates. For example: "10% for stays in September".'
            : missing.includes('discount')
              ? 'How much is the discount? For example "10%".'
              : 'For which stay dates? For example "1 to 30 September".',
        missing,
      };
    }

    const type = advance ? 'EARLY_BOOKING' : minLos ? 'MIN_LOS' : 'PERCENTAGE';
    const code = `${type === 'EARLY_BOOKING' ? `EB${advance}D` : type}-${range!.from.replace(/-/g, '').slice(2, 6)}-${pctValue}`;
    const name =
      type === 'EARLY_BOOKING'
        ? `Early Booking ${advance}D · ${pctValue}%`
        : `${pctValue}% ${range!.label}`;

    return build('create_promotion', {
      kind: 'create_promotion',
      code,
      name,
      validFrom: toStayDate(ctx.now),
      validTo: range!.to,
      definition: {
        type,
        scope: {
          propertyId,
          roomTypeCodes: ctx.roomTypeCode ? [ctx.roomTypeCode] : null,
          ratePlanCodes: ctx.ratePlanCode ? [ctx.ratePlanCode] : null,
        },
        audience: {
          markets: markets.length ? markets : ctx.market ? [ctx.market] : null,
          channels: ['B2B'],
        },
        bookingWindow: advance ? { minAdvanceDays: advance } : {},
        stayWindow: { from: range!.from, to: range!.to },
        los: minLos ? { min: minLos } : {},
        occupancy: {},
        // Guarded above: `missing` returns early when the discount is absent.
        discount: { type: 'PERCENTAGE', value: Math.abs(pctValue!) },
        stacking: { allowed: false, priority: 100 },
      },
    });
  }

  // ── RATES ─────────────────────────────────────────────────
  if (/tarifa|rate|precio|price|bar\b|adr/.test(t) && (DIRECTION_UP.test(t) || DIRECTION_DOWN.test(t) || /\bpon|set\b/.test(t))) {
    if (!propertyId) return needProperty('update_rates');
    const range = extractDateRange(t, ctx.now) ?? defaultRange(ctx);
    if (!range)
      return {
        matched: false,
        intent: 'update_rates',
        confidence: 0.6,
        reason: 'For which dates should I change rates?',
        missing: ['dateRange'],
      };

    const pctValue = extractPercent(t);
    if (pctValue == null) {
      const abs = t.match(/\b(?:a|to|en)\s+(\d+(?:[.,]\d+)?)\b/);
      if (!abs)
        return {
          matched: false,
          intent: 'update_rates',
          confidence: 0.6,
          reason: 'By how much? Say a percentage such as "10%" or an amount.',
          missing: ['value'],
        };
      return build('update_rates', {
        kind: 'update_rates',
        target: targetFrom(propertyId, range, ctx),
        changeType: 'SET',
        value: Number(abs[1].replace(',', '.')),
        currency: ctx.defaultCurrency ?? null,
        reason: utterance,
      });
    }

    const signed = DIRECTION_DOWN.test(t) ? -Math.abs(pctValue) : Math.abs(pctValue);
    return build('update_rates', {
      kind: 'update_rates',
      target: targetFrom(propertyId, range, ctx),
      changeType: 'PERCENTAGE',
      value: signed,
      currency: null,
      reason: utterance,
    });
  }

  // ── RESTRICTIONS ──────────────────────────────────────────
  if (/minimo|min los|minimum stay|noches minimo|estancia minima/.test(t)) {
    if (!propertyId) return needProperty('update_restriction');
    const nights = extractNights(t);
    if (!nights)
      return {
        matched: false,
        intent: 'update_restriction',
        confidence: 0.6,
        reason: 'How many nights minimum?',
        missing: ['minLos'],
      };
    const range = extractDateRange(t, ctx.now) ?? defaultRange(ctx);
    if (!range)
      return {
        matched: false,
        intent: 'update_restriction',
        confidence: 0.6,
        reason: 'For which dates? Select them in the calendar or say a range.',
        missing: ['dateRange'],
      };
    return build('update_restriction', {
      kind: 'update_restriction',
      target: targetFrom(propertyId, range, ctx),
      restriction: { minLos: nights },
      reason: utterance,
    });
  }

  if (/(abre|abrir|open|cierra|cerrar|close|stop sell)\b.*(inventario|inventory|venta|sale|disponibilidad)/.test(t)) {
    if (!propertyId) return needProperty('update_restriction');
    const opening = /(abre|abrir|open)/.test(t);
    const range = extractDateRange(t, ctx.now) ?? defaultRange(ctx);
    if (!range)
      return {
        matched: false,
        intent: 'update_restriction',
        confidence: 0.6,
        reason: 'For which dates?',
        missing: ['dateRange'],
      };
    return build('update_restriction', {
      kind: 'update_restriction',
      target: targetFrom(propertyId, range, ctx),
      restriction: { open: opening },
      reason: utterance,
    });
  }

  if (/(abre|abrir|open|sube|aumenta)\b.*(cupo|allotment)|(\d+)\s*habitaciones?\b.*(abre|libera)/.test(t)) {
    if (!propertyId) return needProperty('update_availability');
    const n = t.match(/(\d{1,4})/);
    const range = extractDateRange(t, ctx.now) ?? defaultRange(ctx);
    if (!n || !range)
      return {
        matched: false,
        intent: 'update_availability',
        confidence: 0.6,
        reason: 'How many rooms, and for which dates?',
        missing: [!n ? 'value' : 'dateRange'],
      };
    return build('update_availability', {
      kind: 'update_availability',
      target: targetFrom(propertyId, range, ctx),
      changeType: 'SET',
      value: Number(n[1]),
      reason: utterance,
    });
  }

  return {
    matched: false,
    intent: 'unknown',
    confidence: 0,
    reason:
      'I could not turn that into an action I am allowed to take. Try: "why am I not selling?", ' +
      '"create a 10% promotion for September in Mexico", "raise rates 10% for Christmas", ' +
      '"set a 3-night minimum here".',
  };
}

function defaultRange(ctx: IntentContext): { from: string; to: string; label: string } | null {
  if (ctx.selectedDates?.length) {
    const sorted = [...ctx.selectedDates].sort();
    return { from: sorted[0], to: sorted[sorted.length - 1], label: 'selected dates' };
  }
  return null;
}

function targetFrom(
  propertyId: string,
  range: { from: string; to: string },
  ctx: IntentContext,
) {
  return {
    propertyId,
    roomTypeCodes: ctx.roomTypeCode ? [ctx.roomTypeCode] : null,
    ratePlanCodes: ctx.ratePlanCode ? [ctx.ratePlanCode] : null,
    from: range.from,
    to: range.to,
    daysOfWeek: null,
    occupancy: null,
  };
}


/* ── Group and event extraction ───────────────────────────
 *
 * Each of these returns null rather than a default. A grammar that guesses
 * "probably 20" produces a comp rule the hotel never agreed to.
 */

/** "una gratuidad por cada 20 habitaciones", "1 free per 15 rooms". */
function extractCompRule(t: string): {
  kind: 'COMP_ROOM';
  everyNRooms: number;
  maxUnits: number | null;
  basis: 'PER_NIGHT' | 'PER_STAY';
  description: null;
} | null {
  const m =
    /(?:gratuidad|habitacion gratis|habitacion gratuita|free room|gratis)\D{0,30}?(\d{1,3})\s*(?:habitacion|habitaciones|rooms?|pax)?/.exec(
      t,
    ) ??
    /(?:cada|per|por cada)\s*(\d{1,3})\s*(?:habitacion|habitaciones|rooms?)\D{0,30}?(?:gratuidad|gratis|free)/.exec(
      t,
    );
  if (!m) return null;
  const every = Number(m[1]);
  if (!Number.isFinite(every) || every < 1 || every > 500) return null;

  const capMatch = /(?:maximo|max|hasta)\s*(\d{1,3})/.exec(t);
  return {
    kind: 'COMP_ROOM',
    everyNRooms: every,
    maxUnits: capMatch ? Number(capMatch[1]) : null,
    basis: /por noche|per night|cada noche/.test(t) ? 'PER_NIGHT' : 'PER_STAY',
    description: null,
  };
}

/** "tarifa piso de grupos 300000 COP", "group floor rate 250 USD". */
function extractGroupFloor(t: string): { amount: number; currency: string | null } | null {
  if (!/(tarifa piso|piso de grupos|tarifa minima|minimo aceptable|floor rate|minimum rate)/.test(t)) {
    return null;
  }
  const m = /(\d[\d.,]{2,})\s*([a-z]{3})?/.exec(t);
  if (!m) return null;
  const amount = toAmount(m[1]);
  if (amount == null) return null;
  const cur = m[2]?.toUpperCase();
  return { amount, currency: cur && /^[A-Z]{3}$/.test(cur) ? cur : null };
}

/** "tienen 48 horas para responder". */
function extractResponseWindow(t: string): number | null {
  const m = /(\d{1,3})\s*(?:horas?|hours?|hrs?)\D{0,24}?(?:responder|respuesta|respond|response|vence|expira)/.exec(t)
    ?? /(?:ventana|window|plazo)\D{0,16}?(\d{1,3})\s*(?:horas?|hours?|hrs?)/.exec(t);
  if (!m) return null;
  const h = Number(m[1]);
  return h >= 1 && h <= 168 ? h : null;
}

function extractMinGroupRooms(t: string): number | null {
  const m = /(?:minimo|minimum|a partir de)\s*(?:de\s*)?(\d{1,3})\s*(?:habitacion|habitaciones|rooms?)/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 2 && n <= 500 ? n : null;
}

function extractDepositPct(t: string): number | null {
  const m = /(?:deposito|anticipo|deposit)\D{0,16}?(\d{1,3})\s*%/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 100 ? n : null;
}

/** A bare figure, for a counter-offer. */
function extractPlainAmount(t: string): number | null {
  const m = /(?:por|a|en|de|at|for)\s*(\d[\d.,]{2,})/.exec(t) ?? /(\d[\d.,]{3,})/.exec(t);
  return m ? toAmount(m[1]) : null;
}

/** Handles both 1.200.000 and 1,200,000 without turning one into the other. */
function toAmount(raw: string): number | null {
  const cleaned = raw.replace(/[.,](?=\d{3}\b)/g, '');
  const n = Number(cleaned.replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Everything leaves through the schema. A grammar bug becomes a validation
 *  error, not a malformed command reaching the policy engine. */
function build(intent: string, candidate: unknown): IntentParseResult {
  const parsed = StructuredCommandSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      matched: false,
      intent,
      confidence: 0.5,
      reason: `Understood as ${intent} but the command failed validation: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    };
  }
  return { matched: true, intent, confidence: 0.9, command: parsed.data };
}
