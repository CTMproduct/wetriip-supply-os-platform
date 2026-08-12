import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { DomainError } from '@wetriip/contracts';

/**
 * Signed internal identity.
 *
 * Before this file, every internal service accepted `x-wetriip-permissions`
 * from whatever sent the request and believed it. That was safe *only* while
 * nothing but the gateway could reach port 3110 — which makes a security group
 * the last line of defence for authority. A misrouted ingress, a debug port
 * left open, a pod on a flat network, and any caller could mint themselves
 * SUPER_ADMIN by typing a header.
 *
 * So the context headers now carry a signature over the claims themselves. A
 * service that receives unsigned or badly-signed context refuses it. Network
 * isolation stays as defence in depth; it stops being the only defence.
 *
 * This is deliberately HMAC and not asymmetric: every service already shares a
 * deployment secret, and a shared symmetric key is honest about the trust
 * boundary it actually implements. When services are split across trust
 * domains, this is where JWS with per-service keys goes, and the call sites do
 * not change.
 */

const SIG_HEADER = 'x-wetriip-signature';
const ISSUED_HEADER = 'x-wetriip-issued-at';
const NONCE_HEADER = 'x-wetriip-nonce';

/** How long a signed internal call stays valid. Bounds replay without
 *  demanding clock sync tighter than any deployment can hold. */
const MAX_SKEW_MS = 120_000;

export function internalSecret(): string {
  const secret = process.env.INTERNAL_SIGNING_SECRET ?? process.env.SESSION_SECRET;
  if (!secret) {
    throw new DomainError({
      code: 'INTERNAL',
      message: 'No internal signing secret is configured.',
      owner: 'Platform Security',
      remediation: 'Set INTERNAL_SIGNING_SECRET (or SESSION_SECRET) on every service.',
    });
  }
  return secret;
}

/**
 * Whether unsigned internal context is tolerated.
 *
 * Off in production, always. On elsewhere only so an operator can curl an
 * internal endpoint while debugging — and every such request is logged as
 * unsigned by the guard that let it through.
 */
export function internalAuthRequired(): boolean {
  if (process.env.INTERNAL_AUTH_REQUIRED === 'true') return true;
  if (process.env.INTERNAL_AUTH_REQUIRED === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

/** The exact bytes signed. Order is fixed so both sides agree without parsing. */
function canonical(claims: Record<string, string>, issuedAt: string, nonce: string): string {
  return [
    claims.tenant ?? '',
    claims.user ?? '',
    claims.org ?? '',
    claims.role ?? '',
    claims.autonomy ?? '',
    claims.permissions ?? '',
    claims.properties ?? '',
    claims.status ?? '',
    issuedAt,
    nonce,
  ].join('\n');
}

/**
 * Produce the three signature headers for a set of claims.
 *
 * The argument is the SHORT-key claim map — the same one `verifyInternalHeaders`
 * is given. Signing the wire-header map instead would canonicalise every field
 * to an empty string and produce a signature that verifies against nothing,
 * which is precisely the bug this signature is supposed to make impossible.
 */
export function signInternalHeaders(claims: Record<string, string>): Record<string, string> {
  const issuedAt = String(Date.now());
  const nonce = randomUUID();
  const sig = createHmac('sha256', internalSecret())
    .update(canonical(claims, issuedAt, nonce))
    .digest('base64url');

  return { [ISSUED_HEADER]: issuedAt, [NONCE_HEADER]: nonce, [SIG_HEADER]: sig };
}

export interface InternalVerification {
  signed: boolean;
  reason?: string;
}

/**
 * Verify the signature over the context claims.
 *
 * Returns rather than throws, so the caller decides whether an unsigned call is
 * fatal (production) or merely logged (development). A verification that
 * silently passed in one mode and failed in another would be a trap.
 */
export function verifyInternalHeaders(
  headers: Record<string, any>,
  claims: Record<string, string>,
): InternalVerification {
  const h = (k: string) => {
    const v = headers[k] ?? headers[k.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };

  const sig = h(SIG_HEADER);
  const issuedAt = h(ISSUED_HEADER);
  const nonce = h(NONCE_HEADER);
  if (!sig || !issuedAt || !nonce) return { signed: false, reason: 'unsigned internal context' };

  const age = Date.now() - Number(issuedAt);
  if (!Number.isFinite(age) || Math.abs(age) > MAX_SKEW_MS) {
    return { signed: false, reason: `internal context timestamp is ${Math.round(age / 1000)}s off` };
  }

  let expected: string;
  try {
    expected = createHmac('sha256', internalSecret())
      .update(canonical(claims, String(issuedAt), String(nonce)))
      .digest('base64url');
  } catch {
    return { signed: false, reason: 'no internal signing secret configured' };
  }

  const a = Buffer.from(expected);
  const b = Buffer.from(String(sig));
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { signed: false, reason: 'internal context signature does not match its claims' };
  }
  return { signed: true };
}

export function assertInternalSignature(verification: InternalVerification): void {
  if (verification.signed || !internalAuthRequired()) return;
  throw new DomainError({
    code: 'PERMISSION',
    message: 'Internal identity could not be verified.',
    owner: 'Platform Security',
    remediation:
      'Internal services accept context only from the gateway. ' +
      `Reason: ${verification.reason ?? 'unknown'}.`,
  });
}

/* ── Step-up ──────────────────────────────────────────────
 *
 * `x-wetriip-step-up: true` was not step-up authentication. It was a boolean a
 * browser could type, and it unlocked every HIGH-risk action in the platform.
 *
 * A step-up proof is now a short-lived, signed assertion BOUND TO ONE ACTION.
 * It cannot be replayed against a different action, a different user, a
 * different tenant, or five minutes later — which are exactly the four things a
 * generic boolean cannot express.
 */

export interface StepUpProof {
  userId: string;
  tenantId: string;
  /** The single action this proof authorises. Never '*'. */
  actionId: string;
  /** Authentication methods actually performed, in OIDC's vocabulary. */
  amr: string[];
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

const STEP_UP_TTL_MS = 5 * 60_000;

export function issueStepUpProof(args: {
  userId: string;
  tenantId: string;
  actionId: string;
  amr: string[];
}): string {
  const now = Date.now();
  const proof: StepUpProof = {
    userId: args.userId,
    tenantId: args.tenantId,
    actionId: args.actionId,
    amr: args.amr,
    issuedAt: now,
    expiresAt: now + STEP_UP_TTL_MS,
    nonce: randomUUID(),
  };
  const body = Buffer.from(JSON.stringify(proof)).toString('base64url');
  const sig = createHmac('sha256', internalSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/**
 * Verify a step-up proof against the action it is being used for.
 *
 * Every mismatch is a distinct refusal with its own message, because "step-up
 * required" tells an operator nothing about whether they need to re-verify or
 * whether something is wrong.
 */
export function verifyStepUpProof(
  token: string | undefined,
  expect: { userId: string; tenantId: string; actionId: string },
): { ok: boolean; reason?: string; amr?: string[] } {
  if (!token) return { ok: false, reason: 'no step-up proof presented' };

  const [body, sig] = token.split('.');
  if (!body || !sig) return { ok: false, reason: 'malformed step-up proof' };

  let expected: string;
  try {
    expected = createHmac('sha256', internalSecret()).update(body).digest('base64url');
  } catch {
    return { ok: false, reason: 'no internal signing secret configured' };
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'step-up proof signature is invalid' };
  }

  let proof: StepUpProof;
  try {
    proof = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'step-up proof is not readable' };
  }

  if (proof.expiresAt < Date.now()) return { ok: false, reason: 'step-up proof has expired' };
  if (proof.userId !== expect.userId) {
    return { ok: false, reason: 'step-up proof belongs to a different user' };
  }
  if (proof.tenantId !== expect.tenantId) {
    return { ok: false, reason: 'step-up proof belongs to a different tenant' };
  }
  if (proof.actionId !== expect.actionId) {
    // The whole point: a proof for one action cannot unlock another.
    return { ok: false, reason: 'step-up proof was issued for a different action' };
  }
  return { ok: true, amr: proof.amr };
}
