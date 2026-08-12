import { CTX_HEADER, contextFromHeaders, contextToHeaders } from './context';
import { issueStepUpProof, verifyStepUpProof } from './internal-identity';
import { productionFindings } from './posture';
import { propertyScope, scopedIdempotencyKey, scopedPropertyWhere } from './scope';

const SECRET = 'a'.repeat(48);

beforeEach(() => {
  process.env.INTERNAL_SIGNING_SECRET = SECRET;
  process.env.INTERNAL_AUTH_REQUIRED = 'true';
});

afterEach(() => {
  delete process.env.INTERNAL_AUTH_REQUIRED;
});

const ctx = {
  tenantId: 't1',
  userId: 'u1',
  organizationId: 'o1',
  role: 'REVENUE_MANAGER',
  maxAutonomy: 2 as const,
  permissions: ['rates.write'] as any,
  propertyIds: ['p1'],
  status: 'ACTIVE',
  correlationId: 'cid',
  stepUpVerified: false,
};

describe('signed internal identity', () => {
  it('round-trips a context the gateway signed', () => {
    const headers = contextToHeaders(ctx);
    const back = contextFromHeaders(headers);
    expect(back.tenantId).toBe('t1');
    expect(back.permissions).toEqual(['rates.write']);
    expect(back.internallySigned).toBe(true);
  });

  it('refuses context with no signature at all', () => {
    // This is the attack the whole file exists for: type the headers, become
    // whoever you like.
    expect(() =>
      contextFromHeaders({
        [CTX_HEADER.tenant]: 't1',
        [CTX_HEADER.user]: 'attacker',
        [CTX_HEADER.role]: 'SUPER_ADMIN',
        [CTX_HEADER.permissions]: 'users.manage,rates.write',
      }),
    ).toThrow(/Internal identity could not be verified/);
  });

  it('refuses when a claim is edited after signing', () => {
    const headers = contextToHeaders(ctx);
    const tampered = { ...headers, [CTX_HEADER.permissions]: 'users.manage,contracts.publish' };
    expect(() => contextFromHeaders(tampered)).toThrow(/could not be verified/);
  });

  it('refuses a signature lifted from another tenant', () => {
    const headers = contextToHeaders(ctx);
    const swapped = { ...headers, [CTX_HEADER.tenant]: 't2' };
    expect(() => contextFromHeaders(swapped)).toThrow(/could not be verified/);
  });

  it('refuses a replayed signature once it is stale', () => {
    const headers = contextToHeaders(ctx);
    const old = { ...headers, 'x-wetriip-issued-at': String(Date.now() - 10 * 60_000) };
    expect(() => contextFromHeaders(old)).toThrow(/could not be verified/);
  });

  it('lets an operator through unsigned only when explicitly permitted', () => {
    process.env.INTERNAL_AUTH_REQUIRED = 'false';
    const back = contextFromHeaders({ [CTX_HEADER.tenant]: 't1', [CTX_HEADER.user]: 'u1' });
    expect(back.internallySigned).toBe(false);
  });
});

describe('step-up proofs', () => {
  const expect_ = { userId: 'u1', tenantId: 't1', actionId: 'a1' };

  it('verifies against the action it was issued for', () => {
    const proof = issueStepUpProof({ ...expect_, amr: ['mfa'] });
    expect(verifyStepUpProof(proof, expect_)).toMatchObject({ ok: true, amr: ['mfa'] });
  });

  it('cannot be replayed against a different action', () => {
    const proof = issueStepUpProof({ ...expect_, amr: ['mfa'] });
    const res = verifyStepUpProof(proof, { ...expect_, actionId: 'a2' });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/different action/);
  });

  it('cannot be used by a different user or tenant', () => {
    const proof = issueStepUpProof({ ...expect_, amr: ['mfa'] });
    expect(verifyStepUpProof(proof, { ...expect_, userId: 'u2' }).reason).toMatch(/different user/);
    expect(verifyStepUpProof(proof, { ...expect_, tenantId: 't2' }).reason).toMatch(/different tenant/);
  });

  it('refuses a boolean, which is what it replaces', () => {
    expect(verifyStepUpProof('true', expect_).ok).toBe(false);
    expect(verifyStepUpProof(undefined, expect_).reason).toMatch(/no step-up proof/);
  });

  it('refuses a forged signature', () => {
    const proof = issueStepUpProof({ ...expect_, amr: ['mfa'] });
    const [body] = proof.split('.');
    expect(verifyStepUpProof(`${body}.forged`, expect_).ok).toBe(false);
  });
});

describe('production posture', () => {
  const base = {
    NODE_ENV: 'production',
    SESSION_SECRET: SECRET,
    OFFER_SIGNING_SECRET: SECRET,
    INTERNAL_SIGNING_SECRET: SECRET,
    OIDC_ISSUER: 'https://id.example.com',
    STEP_UP_VERIFIER: 'idp-acr',
    DATABASE_URL: 'postgres://x',
  } as any;

  it('is satisfied by a fully configured deployment', () => {
    expect(productionFindings(base)).toEqual([]);
  });

  it('names the development placeholder secret', () => {
    const f = productionFindings({ ...base, SESSION_SECRET: 'change-me-in-production' });
    expect(f.map((x) => x.setting)).toContain('SESSION_SECRET');
    expect(f[0].problem).toMatch(/development placeholder/);
  });

  it('rejects a secret too short to sign anything', () => {
    expect(productionFindings({ ...base, OFFER_SIGNING_SECRET: 'short' })).toHaveLength(1);
  });

  it('refuses to accept email-only sign-in as production authentication', () => {
    const f = productionFindings({ ...base, OIDC_ISSUER: undefined });
    expect(f[0].problem).toMatch(/accepts any known email with no credential/);
  });

  it('refuses step-up that verifies nothing', () => {
    const f = productionFindings({ ...base, STEP_UP_VERIFIER: undefined });
    expect(f[0].problem).toMatch(/no second factor is actually checked/);
  });

  it('refuses an explicit opt-out of internal signing', () => {
    const f = productionFindings({ ...base, INTERNAL_AUTH_REQUIRED: 'false' });
    expect(f[0].problem).toMatch(/any caller reaching an internal port/);
  });
});

describe('scoping', () => {
  const staff = { ...ctx, role: 'SUPER_ADMIN' } as any;

  it('narrows a hotel user to their organization and their properties', () => {
    expect(propertyScope(ctx as any)).toEqual({
      tenantId: 't1',
      organizationId: 'o1',
      id: { in: ['p1'] },
    });
  });

  it('reads an empty property scope as the whole organization, not the tenant', () => {
    expect(propertyScope({ ...ctx, propertyIds: [] } as any)).toEqual({
      tenantId: 't1',
      organizationId: 'o1',
    });
  });

  it('lets platform staff see the tenant', () => {
    expect(propertyScope(staff)).toEqual({ tenantId: 't1' });
  });

  it('namespaces idempotency keys so two tenants cannot collide', () => {
    expect(scopedIdempotencyKey('t1', 'booking', 'PMS-123')).not.toBe(
      scopedIdempotencyKey('t2', 'booking', 'PMS-123'),
    );
  });
});

describe('supply scoping must not blind the buyer', () => {
  it('shows an agency the tenant supply, because distribution gates it downstream', () => {
    // Narrowing a buyer to its own organization hides every hotel — the exact
    // inventory it exists to purchase. Caught by the smoke suite returning
    // "0 offers, 0 excluded", which is a different failure from "0 offers".
    const agency = { ...ctx, role: 'AGENCY_ADMIN', organizationId: 'agency-1' } as any;
    expect(propertyScope(agency)).toEqual({ tenantId: 't1' });
  });

  it('still narrows hotel staff to their own organization', () => {
    expect(propertyScope({ ...ctx, propertyIds: [] } as any)).toEqual({
      tenantId: 't1',
      organizationId: 'o1',
    });
  });
});

describe('scoped single-property lookup', () => {
  it('keeps BOTH the requested id and the scope', () => {
    // The trap: `{ id, ...propertyScope(ctx) }` lets the scope's own `id`
    // clause overwrite the requested one, so the query silently answers with a
    // different property and a 200.
    expect(scopedPropertyWhere(ctx as any, 'p-other')).toEqual({
      AND: [{ id: 'p-other' }, { tenantId: 't1', organizationId: 'o1', id: { in: ['p1'] } }],
    });
  });

  it('demonstrates why the spread was wrong', () => {
    const spread = { id: 'p-other', ...propertyScope(ctx as any) };
    expect(spread.id).toEqual({ in: ['p1'] });
  });

  it('is a plain id lookup for platform staff', () => {
    expect(scopedPropertyWhere({ ...ctx, role: 'SUPER_ADMIN' } as any, 'p-other')).toEqual({
      AND: [{ id: 'p-other' }, { tenantId: 't1' }],
    });
  });
});
