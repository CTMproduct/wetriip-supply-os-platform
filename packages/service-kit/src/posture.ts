import { Logger } from '@wetriip/observability';

/**
 * The production posture gate.
 *
 * Every one of these settings is fine — necessary, even — for a laptop and a CI
 * runner. Every one of them is a breach in production. The difference between
 * the two is one environment variable, and relying on a human to remember which
 * mode they are in is how a demo secret ends up signing real sessions.
 *
 * So the process refuses to start. Not a warning in a log nobody reads: a
 * non-zero exit, with the list of what is missing.
 */

const DEV_SECRETS = new Set([
  'change-me-in-production',
  'dev',
  'development',
  'secret',
  'changeme',
  'test',
]);

export interface PostureFinding {
  setting: string;
  problem: string;
  fix: string;
}

/** Everything wrong with the current environment for production use. */
export function productionFindings(env: NodeJS.ProcessEnv = process.env): PostureFinding[] {
  const findings: PostureFinding[] = [];

  const weak = (name: string) => {
    const v = env[name];
    if (!v) {
      findings.push({
        setting: name,
        problem: 'is not set, so the platform would fall back to a shared default',
        fix: `Set ${name} to a high-entropy value unique to this deployment.`,
      });
      return;
    }
    if (DEV_SECRETS.has(v.toLowerCase()) || v.length < 32) {
      findings.push({
        setting: name,
        problem:
          DEV_SECRETS.has(v.toLowerCase())
            ? 'is a well-known development placeholder'
            : `is ${v.length} characters, which is too short to sign anything`,
        fix: `Set ${name} to at least 32 random characters.`,
      });
    }
  };

  weak('SESSION_SECRET');
  weak('OFFER_SIGNING_SECRET');
  weak('INTERNAL_SIGNING_SECRET');

  // The email-only login is a development shim. It authenticates nobody.
  if (!env.OIDC_ISSUER) {
    findings.push({
      setting: 'OIDC_ISSUER',
      problem:
        'is not set, which leaves the development sign-in active — it accepts any known email with no credential',
      fix: 'Point OIDC_ISSUER at the identity provider and configure OIDC_CLIENT_ID / OIDC_JWKS_URI.',
    });
  }

  // Belt and braces: OIDC missing already fails above, but an operator who set
  // OIDC_ISSUER and ALSO left the development sign-in on has left a second,
  // unauthenticated door open next to the real one.
  if (env.DEV_LOGIN_ENABLED === 'true') {
    findings.push({
      setting: 'DEV_LOGIN_ENABLED',
      problem:
        'is on, which accepts any known email address with no credential — alongside whatever real identity provider is configured',
      fix: 'Remove it. The development sign-in must never be reachable in production.',
    });
  }

  if (env.INTERNAL_AUTH_REQUIRED === 'false') {
    findings.push({
      setting: 'INTERNAL_AUTH_REQUIRED',
      problem: 'is explicitly disabled, so any caller reaching an internal port can assert any identity',
      fix: 'Remove the override. Internal context must be signed in production.',
    });
  }

  // Step-up that nothing actually verifies is theatre, and theatre that guards
  // HIGH-risk actions is worse than no guard because it is trusted.
  if (!env.STEP_UP_VERIFIER) {
    findings.push({
      setting: 'STEP_UP_VERIFIER',
      problem:
        'is not set, so no second factor is actually checked before a HIGH-risk action is confirmed',
      fix: 'Set STEP_UP_VERIFIER to the MFA verifier this deployment uses (e.g. the IdP ACR flow).',
    });
  }

  if (!env.DATABASE_URL) {
    findings.push({
      setting: 'DATABASE_URL',
      problem: 'is not set',
      fix: 'Point DATABASE_URL at the production database.',
    });
  }

  return findings;
}

/**
 * Called from every service bootstrap.
 *
 * Outside production it reports the same findings as a warning, so the gap is
 * visible long before somebody flips NODE_ENV and discovers it.
 */
export function assertProductionPosture(service: string, log: Logger): void {
  const findings = productionFindings();
  if (findings.length === 0) return;

  if (process.env.NODE_ENV !== 'production') {
    log.warn('development posture — these would block a production start', {
      service,
      findings: findings.map((f) => `${f.setting}: ${f.problem}`),
    });
    return;
  }

  const detail = findings.map((f) => `  · ${f.setting} ${f.problem}\n    → ${f.fix}`).join('\n');
  throw new Error(
    `Refusing to start ${service} in production.\n\n` +
      `${findings.length} setting(s) would leave this deployment unauthenticated:\n\n${detail}\n\n` +
      'These are not warnings. Each one lets somebody act as somebody else.',
  );
}
