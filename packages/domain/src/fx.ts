import { FxQuote, MoneyTrace } from '@wetriip/contracts';
import Decimal from 'decimal.js';

/**
 * Currency Engine.
 *
 * We never destroy the supplier's original amount. Every offer and every
 * booking carries three amounts — supplier, normalized, buyer — plus the rate,
 * its source and its timestamp.
 *
 * Collapsing everything to USD on ingest is the single cheapest way to make
 * reconciliation impossible: FX moves, the hotel invoices in COP, the agency
 * pays in MXN, and nobody can reproduce the number that was quoted.
 */
export interface FxProvider {
  readonly source: string;
  quote(from: string, to: string, at: Date): FxQuote;
}

/** Development provider. Production replaces this with a rate feed; the
 *  interface is what keeps the swap from touching pricing. */
export class StaticFxProvider implements FxProvider {
  readonly source: string;
  private readonly perUsd: Record<string, number>;

  constructor(perUsd?: Record<string, number>, source = 'static-dev-table') {
    this.source = source;
    this.perUsd = perUsd ?? {
      USD: 1,
      COP: 3981.23,
      MXN: 18.69,
      EUR: 0.92,
      BRL: 5.42,
      PEN: 3.73,
      CLP: 945.5,
      ARS: 1035.0,
    };
  }

  rateOf(code: string): number {
    const r = this.perUsd[code.toUpperCase()];
    if (r == null) throw new Error(`No FX rate configured for ${code}`);
    return r;
  }

  quote(from: string, to: string, at: Date): FxQuote {
    const f = from.toUpperCase();
    const t = to.toUpperCase();
    const rate =
      f === t ? 1 : new Decimal(this.rateOf(t)).div(this.rateOf(f)).toDecimalPlaces(8).toNumber();
    return { from: f, to: t, rate, source: this.source, timestamp: at.toISOString() };
  }
}

export function convert(amount: number, quote: FxQuote): number {
  return new Decimal(amount).mul(quote.rate).toDecimalPlaces(4).toNumber();
}

export function buildMoneyTrace(args: {
  supplierCurrency: string;
  supplierAmount: number;
  normalizationCurrency: string;
  buyerCurrency: string;
  fx: FxProvider;
  at: Date;
}): MoneyTrace {
  const toNormalized = args.fx.quote(args.supplierCurrency, args.normalizationCurrency, args.at);
  const toBuyer = args.fx.quote(args.supplierCurrency, args.buyerCurrency, args.at);
  return {
    supplierCurrency: args.supplierCurrency.toUpperCase(),
    supplierAmount: new Decimal(args.supplierAmount).toDecimalPlaces(4).toNumber(),
    normalizedCurrency: args.normalizationCurrency.toUpperCase(),
    normalizedAmount: convert(args.supplierAmount, toNormalized),
    buyerCurrency: args.buyerCurrency.toUpperCase(),
    buyerAmount: convert(args.supplierAmount, toBuyer),
    fx: toBuyer,
  };
}

/** Zero-decimal currencies round to whole units; the rest to cents. */
const ZERO_DECIMAL = new Set(['COP', 'CLP', 'JPY', 'KRW', 'PYG', 'VND']);

export function roundForCurrency(amount: number, currency: string): number {
  const dp = ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
  return new Decimal(amount).toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toNumber();
}
