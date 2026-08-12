import { SimulationResult, StayDate, StructuredCommand } from '@wetriip/contracts';
import Decimal from 'decimal.js';

/**
 * Simulation Engine.
 *
 * Nothing is written until a human has seen the numbers. The confirmation
 * sentence is generated HERE, from the computed diff — not by the model. A
 * language model that hallucinates "this affects 12 dates" when it affects
 * 2,800 would defeat the entire approval step, so the model never gets to
 * describe its own change.
 */

export interface SimCell {
  stayDate: StayDate;
  roomTypeId: string;
  roomTypeCode: string;
  ratePlanId: string;
  ratePlanCode: string;
  occupancy: number;
  currency: string | null;
  baseAmount: number | null;
  available: number;
  open: boolean;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  minLos: number;
  maxLos: number | null;
  releaseDays: number;
}

export interface SimulateArgs {
  command: StructuredCommand;
  cells: SimCell[];
  /** Rough demand signal for the impact projection. Absent -> no projection,
   *  rather than a fabricated one. */
  expectedRoomNights?: number | null;
  maxSamples?: number;
}

const MAX_SAMPLES = 5;

function pct(a: number, b: number): number | null {
  if (!b) return null;
  return new Decimal(a).sub(b).div(b).mul(100).toDecimalPlaces(2).toNumber();
}

export function simulate(args: SimulateArgs): SimulationResult {
  const { command, cells } = args;
  const warnings: string[] = [];
  const blockers: string[] = [];
  const samples: SimulationResult['samples'] = [];
  const diffs: SimulationResult['diffs'] = [];

  const properties = new Set<string>();
  const roomTypes = new Set(cells.map((c) => c.roomTypeId));
  const ratePlans = new Set(cells.map((c) => c.ratePlanId));
  const stayDates = new Set(cells.map((c) => c.stayDate));
  if ('target' in command) properties.add(command.target.propertyId);
  if (command.kind === 'create_promotion') properties.add(command.definition.scope.propertyId);

  const blastRadius = {
    properties: properties.size,
    roomTypes: roomTypes.size,
    ratePlans: ratePlans.size,
    stayDates: stayDates.size,
    ariCells: cells.length,
  };

  const currency = cells.find((c) => c.currency)?.currency ?? null;
  const before = cells.map((c) => c.baseAmount).filter((x): x is number => x != null);
  const avgBefore = before.length
    ? new Decimal(before.reduce((s, n) => s + n, 0)).div(before.length).toDecimalPlaces(2).toNumber()
    : null;

  let after: number[] = [];
  let confirmationPrompt = '';

  switch (command.kind) {
    case 'update_rates': {
      if (cells.length === 0) blockers.push('No ARI cells match the requested scope.');
      const noPrice = cells.filter((c) => c.baseAmount == null).length;
      if (noPrice > 0)
        warnings.push(`${noPrice} cell(s) have no current price and will be skipped.`);

      after = cells
        .filter((c) => c.baseAmount != null)
        .map((c) => {
          const base = new Decimal(c.baseAmount!);
          if (command.changeType === 'PERCENTAGE')
            return base.mul(100 + command.value).div(100).toDecimalPlaces(2).toNumber();
          if (command.changeType === 'ABSOLUTE')
            return base.add(command.value).toDecimalPlaces(2).toNumber();
          return new Decimal(command.value).toDecimalPlaces(2).toNumber();
        });

      const negative = after.filter((a) => a <= 0).length;
      if (negative > 0) blockers.push(`${negative} cell(s) would end at zero or below.`);

      cells
        .filter((c) => c.baseAmount != null)
        .slice(0, args.maxSamples ?? MAX_SAMPLES)
        .forEach((c, i) => {
          samples.push({
            stayDate: c.stayDate,
            roomTypeCode: c.roomTypeCode,
            ratePlanCode: c.ratePlanCode,
            before: { baseAmount: c.baseAmount, currency: c.currency },
            after: { baseAmount: after[i], currency: c.currency },
          });
        });

      diffs.push({
        scope: 'ARI/EFFECTIVE',
        field: 'baseAmount',
        before: avgBefore,
        after: after.length
          ? new Decimal(after.reduce((s, n) => s + n, 0)).div(after.length).toDecimalPlaces(2).toNumber()
          : null,
        count: after.length,
      });

      const verb =
        command.changeType === 'PERCENTAGE'
          ? `${command.value > 0 ? '+' : ''}${command.value}%`
          : command.changeType === 'ABSOLUTE'
            ? `${command.value > 0 ? '+' : ''}${command.value} ${currency ?? ''}`
            : `set to ${command.value} ${currency ?? ''}`;
      confirmationPrompt =
        `Apply ${verb} to ${blastRadius.ariCells} ARI cells across ` +
        `${blastRadius.roomTypes} room type(s), ${blastRadius.ratePlans} rate plan(s) and ` +
        `${blastRadius.stayDates} stay date(s).`;
      break;
    }

    case 'update_availability': {
      if (cells.length === 0) blockers.push('No ARI cells match the requested scope.');
      const afterAvail = cells.map((c) =>
        command.changeType === 'SET'
          ? Math.max(0, command.value)
          : Math.max(0, c.available + command.value),
      );
      const closing = afterAvail.filter((a) => a === 0).length;
      if (closing > 0)
        warnings.push(`${closing} cell(s) would drop to zero availability and stop being sellable.`);

      cells.slice(0, args.maxSamples ?? MAX_SAMPLES).forEach((c, i) => {
        samples.push({
          stayDate: c.stayDate,
          roomTypeCode: c.roomTypeCode,
          ratePlanCode: c.ratePlanCode,
          before: { available: c.available },
          after: { available: afterAvail[i] },
        });
      });
      diffs.push({
        scope: 'ARI/EFFECTIVE',
        field: 'available',
        before: cells.length
          ? Math.round(cells.reduce((s, c) => s + c.available, 0) / cells.length)
          : 0,
        after: afterAvail.length
          ? Math.round(afterAvail.reduce((s, n) => s + n, 0) / afterAvail.length)
          : 0,
        count: cells.length,
      });
      confirmationPrompt =
        `${command.changeType === 'SET' ? 'Set' : 'Adjust'} availability ` +
        `${command.changeType === 'SET' ? 'to' : 'by'} ${command.value} on ` +
        `${blastRadius.ariCells} ARI cells over ${blastRadius.stayDates} date(s).`;
      break;
    }

    case 'update_restriction': {
      if (cells.length === 0) blockers.push('No ARI cells match the requested scope.');
      const r = command.restriction;
      const changed: string[] = [];
      for (const [field, value] of Object.entries(r)) {
        if (value === undefined || value === null) continue;
        changed.push(`${field}=${value}`);
        diffs.push({
          scope: 'ARI/MANAGED',
          field,
          before: '(varies)',
          after: value,
          count: cells.length,
        });
      }
      if (changed.length === 0) blockers.push('No restriction field supplied.');
      if (r.open === false)
        warnings.push('This closes inventory: the affected dates will disappear from search.');

      cells.slice(0, args.maxSamples ?? MAX_SAMPLES).forEach((c) => {
        samples.push({
          stayDate: c.stayDate,
          roomTypeCode: c.roomTypeCode,
          ratePlanCode: c.ratePlanCode,
          before: {
            open: c.open,
            minLos: c.minLos,
            maxLos: c.maxLos,
            cta: c.closedToArrival,
            ctd: c.closedToDeparture,
          },
          after: { ...r },
        });
      });
      confirmationPrompt = `Apply ${changed.join(', ')} to ${blastRadius.ariCells} ARI cells over ${blastRadius.stayDates} date(s).`;
      break;
    }

    case 'create_promotion': {
      const d = command.definition;
      const discountLabel =
        d.discount.type === 'PERCENTAGE'
          ? `${d.discount.value}%`
          : d.discount.type === 'FIXED'
            ? `${d.discount.value} ${d.discount.currency}`
            : `stay ${d.discount.stayNights} pay ${d.discount.payNights}`;

      const markets = d.audience?.markets?.length ? d.audience.markets.join(', ') : 'all markets';
      after = cells
        .filter((c) => c.baseAmount != null)
        .map((c) =>
          d.discount.type === 'PERCENTAGE'
            ? new Decimal(c.baseAmount!).mul(100 - d.discount.value).div(100).toDecimalPlaces(2).toNumber()
            : c.baseAmount!,
        );

      diffs.push({
        scope: 'OFFER',
        field: 'effective price for eligible buyers',
        before: avgBefore,
        after: after.length
          ? new Decimal(after.reduce((s, n) => s + n, 0)).div(after.length).toDecimalPlaces(2).toNumber()
          : null,
        count: after.length,
      });

      if (!d.stacking?.allowed)
        warnings.push('Promotion is not stackable; it will suppress other eligible promotions.');

      confirmationPrompt =
        `Create "${command.name}" — ${discountLabel} off, stays ${d.stayWindow.from} to ${d.stayWindow.to}, ` +
        `${markets}. Affects ${blastRadius.ratePlans} rate plan(s) and ${blastRadius.stayDates} stay date(s). ` +
        `${d.stacking?.allowed ? 'Stackable with other promotions.' : 'Will not combine with other promotions.'}`;
      break;
    }

    case 'update_promotion': {
      const changed = Object.entries(command.changes)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('/') : v}`);
      if (changed.length === 0) blockers.push('No field supplied to change.');
      for (const [field, value] of Object.entries(command.changes)) {
        if (value === undefined || value === null) continue;
        diffs.push({
          scope: 'PROMOTION',
          field,
          before: '(current version)',
          after: value,
          count: 1,
        });
      }
      confirmationPrompt = `Update promotion ${command.promotionId}: ${changed.join(', ')}. A new version is written; the current one stays in history.`;
      break;
    }

    case 'set_promotion_status': {
      diffs.push({
        scope: 'PROMOTION',
        field: 'status',
        before: '(current)',
        after: command.status,
        count: 1,
      });
      if (command.status === 'CANCELLED') {
        warnings.push('Cancelling is final for this promotion. It can be replaced, not reactivated.');
      }
      confirmationPrompt = `Set promotion ${command.promotionId} to ${command.status}. A new version is written; nothing is deleted.`;
      break;
    }

    // These do not touch ARI cells, so blast radius is not the right measure of
    // them. What a human needs before confirming is the CONTENT of the change
    // read back in words — which is exactly what the confirmation prompt is.
    case 'set_group_policy': {
      const parts: string[] = [];
      if (command.minRoomsForGroup != null) parts.push(`mínimo ${command.minRoomsForGroup} habitaciones`);
      if (command.floorRatePerNight != null) {
        parts.push(`tarifa piso ${command.floorRatePerNight} ${command.floorCurrency ?? ''}`.trim());
      }
      if (command.responseWindowHours != null) parts.push(`ventana de ${command.responseWindowHours} h`);
      if (command.depositPct != null) parts.push(`depósito ${command.depositPct}%`);
      for (const b of command.benefits ?? []) {
        parts.push(
          `${b.kind === 'COMP_ROOM' ? 'una gratuidad' : b.kind} por cada ${b.everyNRooms} habitaciones` +
            (b.basis === 'PER_NIGHT' ? ' por noche' : ''),
        );
      }
      if (parts.length === 0) {
        blockers.push('The command changes nothing — every field was left empty.');
      }
      confirmationPrompt = `Política de grupos: ${parts.join(', ')}. ¿Confirmo?`;
      break;
    }

    case 'upsert_event_space': {
      const caps = command.layouts
        .map((l) => `${l.layout} ${l.capacity}`)
        .join(', ');
      const rates = command.rates.map((r) => `${r.unit} ${r.amount}`).join(', ');
      const addons = command.addons?.length ?? 0;
      confirmationPrompt =
        `Salón "${command.name}" (${command.code}): ${caps}. Tarifas: ${rates}. ` +
        `${addons} servicio(s) adicional(es). ¿Lo guardo?`;
      break;
    }

    case 'respond_group_request': {
      confirmationPrompt =
        command.decision === 'COUNTER'
          ? `Contraofertar ${command.counterTotal} a la agencia. ¿Confirmo?`
          : command.decision === 'ACCEPT'
            ? 'Aceptar el grupo en los términos que están sobre la mesa. ¿Confirmo?'
            : 'Rechazar el grupo. ¿Confirmo?';
      if (command.decision === 'ACCEPT') {
        warnings.push('Accepting commits the rooms and the price. It cannot be undone from here.');
      }
      break;
    }

    case 'rollback_action': {
      confirmationPrompt = `Roll back agent action ${command.actionId}. A new version will be written; nothing is deleted.`;
      break;
    }

    default:
      confirmationPrompt = 'Read-only command; nothing will be changed.';
  }

  const avgAfter = after.length
    ? new Decimal(after.reduce((s, n) => s + n, 0)).div(after.length).toDecimalPlaces(2).toNumber()
    : null;

  const adrDeltaPct = avgAfter != null && avgBefore != null ? pct(avgAfter, avgBefore) : null;

  // Only projected when we were actually given a demand signal. An invented
  // revenue number is worse than no number: people act on it.
  const estimatedRevenueImpact =
    avgAfter != null && avgBefore != null && args.expectedRoomNights
      ? new Decimal(avgAfter).sub(avgBefore).mul(args.expectedRoomNights).toDecimalPlaces(2).toNumber()
      : null;

  return {
    feasible: blockers.length === 0,
    blastRadius,
    diffs,
    samples,
    projections: {
      avgBefore,
      avgAfter,
      minAfter: after.length ? Math.min(...after) : null,
      maxAfter: after.length ? Math.max(...after) : null,
      adrDeltaPct,
      estimatedRevenueImpact,
      currency,
    },
    warnings,
    blockers,
    confirmationPrompt,
  };
}
