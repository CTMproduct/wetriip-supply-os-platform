/**
 * Prisma returns Decimal objects and BigInt for the columns where precision
 * matters. Both serialize badly through JSON, and a silently wrong number in a
 * price is the worst kind of bug, so the conversion happens in exactly one
 * place.
 */
export function toNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') return Number(v);
  if (typeof v === 'object' && 'toNumber' in (v as any)) return (v as any).toNumber();
  return Number(v as any);
}

export function toIso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  return typeof v === 'string' ? v : v.toISOString();
}

export function toStayDateString(v: Date | string): string {
  if (typeof v === 'string') return v.slice(0, 10);
  return v.toISOString().slice(0, 10);
}

/** JSON.stringify replacer that survives BigInt and Decimal. */
export function jsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => {
      if (typeof v === 'bigint') return v.toString();
      if (v && typeof v === 'object' && typeof (v as any).toNumber === 'function')
        return (v as any).toNumber();
      return v;
    }),
  );
}
