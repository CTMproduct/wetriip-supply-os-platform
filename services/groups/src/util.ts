/**
 * Prisma hands back Decimal objects. Converting them at the edge of the service
 * keeps the arithmetic in `@wetriip/domain` working on plain numbers, which is
 * what makes those engines testable without a database.
 */
export function toNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const n = Number(v.toString());
  return Number.isFinite(n) ? n : null;
}

export function money(amount: number, currency: string): string {
  const zeroDecimal = ['COP', 'CLP', 'JPY', 'KRW'].includes(currency);
  return `${amount.toLocaleString('es-CO', {
    maximumFractionDigits: zeroDecimal ? 0 : 2,
  })} ${currency}`;
}
