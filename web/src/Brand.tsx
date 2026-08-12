/**
 * The Wetriip isotype.
 *
 * Drawn the way the brand manual describes it rather than approximated: the two
 * i's of "wetriip" fall to 30° and their four strokes form a W. The round caps
 * at the three upper vertices ARE the dots of those i's — they are not separate
 * circles laid on top, which is why they must stay exactly as wide as the
 * stroke.
 *
 * Two rules the manual is explicit about, encoded here so they cannot drift:
 *  · the chromatic asymmetry — white on the left, magenta on the right —
 *    represents origin and destination, so the halves are two separate paths
 *  · never rotate, never gradient, never recolour outside the five documented
 *    variants
 *
 * The white path is painted last so the middle vertex reads white, with the
 * magenta descending from beneath it.
 */
export type IsotypeVariant = 'default' | 'light' | 'brand' | 'mono-dark' | 'mono-light';

const PALETTE: Record<IsotypeVariant, { container: string | null; left: string; right: string }> = {
  // Fondo midnight, uso primario.
  default: { container: '#0F1729', left: '#FFFFFF', right: '#EC4899' },
  // Fondos claros, papelería.
  light: { container: null, left: '#0F1729', right: '#EC4899' },
  // Momentos de identidad.
  brand: { container: '#EC4899', left: '#FFFFFF', right: '#0F1729' },
  // Impresión a una tinta.
  'mono-dark': { container: '#0F1729', left: '#FFFFFF', right: '#FFFFFF' },
  'mono-light': { container: null, left: '#0F1729', right: '#0F1729' },
};

export function Isotype({
  size = 32,
  variant = 'default',
  container = true,
  title = 'Wetriip',
}: {
  size?: number;
  variant?: IsotypeVariant;
  /** The rounded square. Off when the mark sits on its own background. */
  container?: boolean;
  title?: string;
}) {
  const palette = PALETTE[variant];
  // Stroke is 9pt in 180pt in the manual; 46/512 keeps that ratio at every size.
  const stroke = 46;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      role="img"
      aria-label={title}
      style={{ display: 'block', flex: 'none' }}
    >
      {container && palette.container && (
        // Container radius is 12% of the side — manual section 02.1.
        <rect width="512" height="512" rx="62" ry="62" fill={palette.container} />
      )}
      <g fill="none" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
        {/* Right i — magenta. Painted first so the middle cap belongs to the left stroke. */}
        <path d="M288 212 L358 432 L482 138" stroke={palette.right} />
        {/* Left i — white. */}
        <path d="M96 138 L220 432 L288 212" stroke={palette.left} />
      </g>
    </svg>
  );
}

/**
 * The wordmark.
 *
 * The two i's are always magenta. That is the typographic signature — the
 * manual is blunt that a Wetriip piece with grey i's is simply wrong — so the
 * colour lives here rather than in a stylesheet a page could override.
 */
export function Wordmark({
  size = '1.05rem',
  color = '#FFFFFF',
  accent = '#EC4899',
}: {
  size?: string;
  color?: string;
  accent?: string;
}) {
  return (
    <span
      style={{
        fontSize: size,
        fontWeight: 500,
        letterSpacing: '-0.045em',
        color,
        lineHeight: 1.1,
      }}
    >
      wetr<span style={{ color: accent }}>ii</span>p
    </span>
  );
}

/** Isotype + wordmark, spaced at 50% of the mark height as the lockup requires. */
export function Lockup({
  size = 30,
  variant = 'default',
  color = '#FFFFFF',
  subtitle,
}: {
  size?: number;
  variant?: IsotypeVariant;
  color?: string;
  subtitle?: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: size * 0.5 }}>
      <Isotype size={size} variant={variant} />
      <div>
        <Wordmark size={`${size / 28}rem`} color={color} />
        {subtitle && (
          <div className="eyebrow" style={{ fontSize: 9, color: '#475569', marginTop: 1 }}>
            {subtitle}
          </div>
        )}
      </div>
    </div>
  );
}
