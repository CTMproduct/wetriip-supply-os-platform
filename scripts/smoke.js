#!/usr/bin/env node
/**
 * End-to-end smoke test against a running platform.
 *
 * Exercises the claims that matter, in the order they matter:
 *   1. idempotent re-ingest produces zero new effect
 *   2. the diagnostic engine explains a real blockage
 *   3. the agent proposes but cannot execute without confirmation
 *   4. policy refuses a change beyond the tenant's limits
 *   5. confirmation executes and writes to the MANAGED layer
 *   6. rollback creates a new version rather than deleting anything
 *   7. search produces a signed, explainable offer
 *   8. booking is idempotent under replay
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3100';

let auth = {};
let failures = 0;
let checks = 0;

function ok(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...auth, ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, ok: res.ok, body: parsed };
}

async function login(email) {
  const res = await api('POST', '/api/v1/auth/login', { email });
  if (!res.ok) throw new Error(`login failed for ${email}: ${JSON.stringify(res.body)}`);
  auth = { authorization: `Bearer ${res.body.token}` };
  return res.body.claims;
}

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (n) => iso(new Date(Date.now() + n * 86400000));

async function main() {
  console.log('\n=== WETRIIP SUPPLY OS — SMOKE ===\n');

  // ── Setup ────────────────────────────────────────────────
  const claims = await login('melisa@caribehotels.co');
  console.log(`signed in: ${claims.name} · ${claims.role} · autonomy ${claims.maxAutonomy}\n`);

  const props = await api('GET', '/api/v1/properties');
  const cartagena = props.body.find((p) => p.code === 'WT-CTG-001');
  ok('properties are visible', !!cartagena, `${props.body.length} properties`);

  // ── 1. Idempotency ───────────────────────────────────────
  console.log('\n[1] ARI idempotency — replaying an identical pull');
  const conns = await api('GET', '/api/v1/connectivity/health?propertyId=' + cartagena.id);
  const conn = conns.body[0];
  const replay = await api('POST', `/api/v1/connectivity/connections/${conn.connectionId}/pull`, {
    from: addDays(0),
    to: addDays(10),
  });
  ok(
    'replayed events are recognised as duplicates, not applied twice',
    replay.ok && replay.body.ingest.accepted === 0 && replay.body.ingest.duplicates > 0,
    `accepted=${replay.body?.ingest?.accepted} duplicates=${replay.body?.ingest?.duplicates}`,
  );

  // ── 2. Diagnosis ─────────────────────────────────────────
  console.log('\n[2] "Why am I not selling?"');
  const diag = await api('POST', '/api/v1/agent/ask', {
    utterance: '¿Por qué no estoy vendiendo?',
    context: { propertyId: cartagena.id },
  });
  ok('diagnostic agent answers without confirmation', diag.ok && !diag.body.requiresConfirmation);
  ok(
    'the answer names concrete causes',
    diag.ok && /closed to arrival|no ha|has not|search|rate/i.test(diag.body.speech ?? ''),
  );
  console.log(`        "${(diag.body.speech ?? '').slice(0, 220)}"`);

  // ── 3. Propose, do not execute ───────────────────────────
  console.log('\n[3] Agent proposes a promotion but must not execute it');
  // The grammar derives the promotion code from the discount, and promotion
  // codes are unique per tenant — as they should be. Varying the discount per
  // run keeps this script re-runnable without weakening any assertion, and
  // exercises the grammar with different input each time.
  const pct = 5 + (Math.floor(Date.now() / 1000) % 15);
  // Rotate across the months that actually have inventory loaded, so a rerun
  // cannot collide on the generated code AND cannot target an empty window.
  // A promotion for dates with no ARI legitimately affects 0 cells; that is the
  // platform being right, not a bug, so the test must not ask for it.
  const MONTH_NAMES = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
  ];
  const monthOffset = Math.floor(Date.now() / 1000) % 2;
  const month = MONTH_NAMES[(new Date().getMonth() + monthOffset) % 12];
  const promotionsBefore = (await api('GET', `/api/v1/promotions?propertyId=${cartagena.id}`)).body
    .length;

  const promoAsk = await api('POST', '/api/v1/agent/ask', {
    utterance: `Crea una promoción para reservas hechas con mínimo 30 días de anticipación, ${pct}% de descuento, para ${month}, solamente México.`,
    context: { propertyId: cartagena.id },
  });
  ok('command parsed into a structured promotion', promoAsk.ok && promoAsk.body.action?.command?.kind === 'create_promotion');
  ok('execution is withheld pending confirmation', promoAsk.body?.requiresConfirmation === true);
  ok(
    'intent came from the deterministic grammar (no model required)',
    promoAsk.body?.action?.deterministicIntent === true,
  );
  const sim = promoAsk.body?.action?.simulation;
  ok('simulation reports a concrete blast radius', !!sim && sim.blastRadius.ariCells > 0,
    sim ? `${sim.blastRadius.ariCells} cells / ${sim.blastRadius.stayDates} dates` : 'none');
  console.log(`        "${(promoAsk.body.speech ?? '').slice(0, 240)}"`);

  const status = await api('GET', '/api/v1/promotions?propertyId=' + cartagena.id);
  ok(
    'nothing was written before confirmation',
    status.ok && status.body.length === promotionsBefore,
    `${status.body?.length ?? '?'} promotions before and after the proposal`,
  );

  // ── 4. Policy refuses an over-limit change ───────────────
  console.log('\n[4] Policy engine refuses a change beyond the tenant limit');
  const tooBig = await api('POST', '/api/v1/agent/ask', {
    utterance: 'Sube mis tarifas 45% para septiembre',
    context: { propertyId: cartagena.id },
  });
  ok(
    'over-limit rate change is denied',
    tooBig.ok && tooBig.body.action?.status === 'REJECTED',
    tooBig.body?.action?.policyDecision?.denialReason ?? tooBig.body?.speech,
  );

  // ── 5. Confirm and execute ───────────────────────────────
  console.log('\n[5] Confirmation executes deterministically');
  const confirm = await api('POST', `/api/v1/agent/actions/${promoAsk.body.action.id}/confirm`);
  ok('confirmed action executes', confirm.ok && confirm.body.action?.status === 'EXECUTED',
    confirm.body?.speech ?? JSON.stringify(confirm.body?.error));

  const after = await api('GET', '/api/v1/promotions?propertyId=' + cartagena.id);
  const created = after.body?.find(
    (p) => p.id === confirm.body?.action?.result?.details?.promotionId,
  );
  ok(
    'promotion is now live',
    after.ok && after.body.length === promotionsBefore + 1 && created?.status === 'ACTIVE',
    created?.name,
  );

  // ── 6. Rollback ──────────────────────────────────────────
  console.log('\n[6] Rollback writes a new version, deletes nothing');
  const rollback = await api('POST', `/api/v1/agent/actions/${promoAsk.body.action.id}/rollback`, {
    reason: 'smoke test',
  });
  ok('rollback succeeds', rollback.ok, rollback.body?.summary ?? JSON.stringify(rollback.body?.error));
  const afterRollback = await api('GET', '/api/v1/promotions?propertyId=' + cartagena.id);
  const reverted = afterRollback.body?.find((p) => p.id === created?.id);
  ok(
    'the promotion row still exists, cancelled at a higher version',
    afterRollback.ok &&
      afterRollback.body.length === promotionsBefore + 1 &&
      reverted?.status === 'CANCELLED' &&
      reverted?.version > 1,
    `status=${reverted?.status} version=${reverted?.version}`,
  );

  // ── 7. Search ────────────────────────────────────────────
  console.log('\n[7] Search produces signed, explainable offers');
  await login('gerencia@ctmenlinea.com.co');
  const search = await api('POST', '/api/v1/search', {
    destination: 'Cartagena',
    checkIn: addDays(30),
    checkOut: addDays(33),
    rooms: 1,
    adults: 2,
    children: 0,
    market: 'CO',
    currency: 'USD',
    channel: 'B2B',
  });
  ok('search returns offers', search.ok && search.body.offers?.length > 0,
    `${search.body?.offers?.length ?? 0} offers, ${search.body?.excluded?.length ?? 0} excluded`);
  const offer = search.body?.offers?.[0];
  if (offer) {
    ok('offer is signed and has a TTL', !!offer.signature && !!offer.expiresAt);
    ok('offer keeps supplier, normalized and buyer amounts',
      offer.price.money.supplierCurrency === 'COP' &&
        offer.price.money.buyerCurrency === 'USD' &&
        offer.price.money.supplierAmount > 0,
      `${offer.price.money.supplierAmount} COP -> ${offer.price.money.buyerAmount} USD @ ${offer.price.money.fx.rate}`);
    ok('offer carries a full price explanation',
      Array.isArray(offer.price.steps) && offer.price.steps.length >= 2,
      offer.price.steps.map((s) => s.step).join(' -> '));
    ok('offer carries ARI provenance', offer.provenance?.freshnessSeconds >= 0);
  }
  const excludedWithReason = (search.body?.excluded ?? []).filter((e) => e.reason && e.reason !== 'ok');
  ok('excluded properties state why', excludedWithReason.length === (search.body?.excluded?.length ?? 0),
    excludedWithReason[0]?.reason);

  // ── 8. Booking idempotency ───────────────────────────────
  if (offer) {
    console.log('\n[8] Booking is idempotent under replay');
    const key = `smoke-${Date.now()}`;
    const payload = {
      offerId: offer.offerId,
      idempotencyKey: key,
      guest: { name: 'Prueba Humo', email: 'prueba@ctmenlinea.com.co' },
      adults: 2,
      children: 0,
    };
    const first = await api('POST', '/api/v1/bookings', payload);
    ok('booking created', first.ok, `${first.body?.reference} status=${first.body?.status}`);
    const second = await api('POST', '/api/v1/bookings', payload);
    ok('replay returns the SAME booking, not a second one',
      second.ok && second.body?.id === first.body?.id,
      `${first.body?.id} vs ${second.body?.id}`);
    ok('UNKNOWN is modelled as a real state',
      ['CONFIRMED', 'UNKNOWN', 'REJECTED'].includes(first.body?.status),
      first.body?.status);
  }

  // ── 9. Audit ─────────────────────────────────────────────
  console.log('\n[9] Audit trail');
  await login('ops@wetriip.ai');
  const audit = await api('GET', '/api/v1/audit?limit=50');
  ok('privileged actions are recorded', audit.ok && audit.body.length > 0, `${audit.body?.length} entries`);
  const hasAgent = (audit.body ?? []).some((a) => a.actorType === 'AGENT');
  ok('agent actions are attributed to the agent actor', hasAgent);

  // ── 10. Conformance ──────────────────────────────────────
  console.log('\n[10] Adapter conformance gate');
  const conformance = await api('POST', '/api/v1/connectivity/providers/MOCK_CM/conformance');
  ok('mock adapter is certified', conformance.ok && conformance.body.certified === true,
    `${conformance.body?.checks?.filter((c) => c.passed).length}/${conformance.body?.checks?.length} checks`);
  const providers = await api('GET', '/api/v1/connectivity/providers');
  const uncertified = (providers.body ?? []).filter((p) => !p.capabilities.receiveAriPush && !p.capabilities.fetchAriPull);
  ok('uncertified providers advertise no ARI capability',
    uncertified.length >= 4,
    uncertified.map((p) => p.provider).join(', '));


  // ── 11. Hotel profile ────────────────────────────────────
  console.log('\n[11] Hotel profile: layers, completeness, licensing');
  await login('melisa@caribehotels.co');
  const content = await api('GET', `/api/v1/properties/${cartagena.id}/content`);
  ok(
    'profile is readable',
    content.ok && !!content.body.values.descriptionShort,
    `${Math.round((content.body?.completeness ?? 0) * 100)}% complete, ${content.body?.images?.length ?? 0} image(s)`,
  );
  ok(
    'every field carries its provenance',
    !!content.body?.explanation?.fields?.descriptionShort?.layer,
    content.body?.explanation?.fields?.descriptionShort?.layer,
  );

  const bogotaId = props.body.find((p) => p.code === 'WT-BOG-002').id;
  const thin = await api('GET', `/api/v1/properties/${bogotaId}/content`);
  ok(
    'an incomplete profile says exactly what is missing',
    thin.ok && thin.body.missing.length > 0,
    thin.body?.missing?.join(', '),
  );

  const sources = await api('GET', `/api/v1/properties/${cartagena.id}/content/sources`);
  const booking = (sources.body ?? []).find((x) => x.kind === 'BOOKING');
  ok(
    'Booking.com is registered as NOT certified with its requirements stated',
    !!booking && !booking.certified && booking.requirements.length > 0,
    booking?.requirements?.[0],
  );

  const badImport = await api('POST', `/api/v1/properties/${cartagena.id}/content/import`, {
    kind: 'BOOKING',
  });
  ok(
    'importing from an uncertified source is refused, not faked',
    !badImport.ok && badImport.body?.error?.code === 'NOT_IMPLEMENTED',
    (badImport.body?.error?.remediation ?? '').slice(0, 80),
  );

  // ── 12. Distribution ─────────────────────────────────────
  console.log('\n[12] Distribution policy gates search before pricing');
  const reach = await api('GET', `/api/v1/properties/${cartagena.id}/distribution/reach`);
  ok(
    'reach lists who can see the hotel and why not',
    reach.ok && reach.body.partners.length > 0,
    reach.body?.partners?.map((x) => `${x.name}:${x.canSee ? 'yes' : 'no'}`).join(' '),
  );

  const bogotaReach = await api('GET', `/api/v1/properties/${bogotaId}/distribution/reach`);
  const excludedPartner = (bogotaReach.body?.partners ?? []).find((x) => !x.canSee);
  ok(
    'a partner-exclusive hotel names the rule that blocks everyone else',
    !!excludedPartner?.reason,
    `${excludedPartner?.name}: ${excludedPartner?.reason}`,
  );

  await login('gerencia@ctmenlinea.com.co');
  const blockedSearch = await api('POST', '/api/v1/search', {
    destination: 'Cartagena',
    checkIn: addDays(40),
    checkOut: addDays(42),
    rooms: 1,
    adults: 2,
    children: 0,
    market: 'VE',
    currency: 'USD',
    channel: 'B2B',
  });
  const blocked = (blockedSearch.body?.excluded ?? []).filter((e) =>
    (e.predicates ?? []).some((x) => x.startsWith('DISTRIBUTION_')),
  );
  ok(
    'a blocked market is excluded by distribution, before any rate is computed',
    blockedSearch.ok && blocked.length > 0,
    blocked[0]?.reason,
  );

  // ── 13. Partner credit ───────────────────────────────────
  console.log('\n[13] Partner profiles and credit');
  await login('ops@wetriip.ai');
  const partners = await api('GET', '/api/v1/partners');
  ok(
    'partners carry a code, a tax identity and a credit line',
    partners.ok && partners.body.length >= 2 && partners.body.every((x) => x.partnerCode),
    partners.body?.map((x) => `${x.partnerCode} ${x.taxIdScheme ?? ''}${x.taxId ?? ''}`).join(' · '),
  );

  const ctm = (partners.body ?? []).find((x) => x.partnerCode === 'CTM-001');
  ok(
    'credit shows limit, used and available',
    !!ctm && ctm.creditAvailable === ctm.creditLimit - ctm.creditUsed,
    `${ctm?.creditUsed}/${ctm?.creditLimit} ${ctm?.currency}`,
  );
  ok(
    'a confirmed booking placed a hold on the credit line',
    !!ctm && ctm.creditUsed > 0,
    `used ${ctm?.creditUsed} ${ctm?.currency}`,
  );

  // ── 14. Demand intelligence ──────────────────────────────
  console.log('\n[14] Demand intelligence');
  const demand = await api('GET', `/api/v1/properties/${cartagena.id}/demand?days=30`);
  ok(
    'impressions are recorded per property per search',
    demand.ok && demand.body.impressions > 0,
    `${demand.body?.impressions} impression(s), ${demand.body?.offered} quoted`,
  );
  ok(
    'demand is attributed to a named buyer',
    demand.ok && demand.body.buyers.length > 0,
    demand.body?.buyers?.[0]?.buyerName,
  );

  const flow = await api('GET', '/api/v1/travel-flow?direction=OUTBOUND&anchor=CO&days=30');
  ok(
    'outbound travel flow is derivable from observed demand',
    flow.ok && Array.isArray(flow.body.rows),
    `${flow.body?.rows?.length ?? 0} route(s)`,
  );
  ok(
    'travel flow states it is observed demand, not a national statistic',
    /not a national tourism statistic/i.test(flow.body?.basis ?? ''),
  );

  // ── 15. Roles and permissions ────────────────────────────
  // The claim under test: the same request, made by three different people,
  // gets three different answers — and each refusal names its reason.
  console.log('\n[15] Roles, permissions and platform administration');

  const ec = await login('ecommerce@caribehotels.co');
  ok(
    'the e-commerce analyst signs in with read authority only',
    ec.permissions.includes('analytics.read') && !ec.permissions.includes('rates.write'),
    `${ec.permissions.length} permissions`,
  );

  const ecRead = await api('GET', `/api/v1/properties/${cartagena.id}/revenue`);
  ok('e-commerce can read the revenue advisory', ecRead.ok);

  const ecWrite = await api('POST', `/api/v1/properties/${cartagena.id}/distribution`, {
    mode: 'MARKETPLACE',
  });
  ok(
    'e-commerce is refused a distribution write, with the reason',
    ecWrite.status === 403 &&
      /distribution\.write/.test(JSON.stringify(ecWrite.body)),
    ecWrite.body?.error?.message,
  );

  const ecAsk = await api('POST', '/api/v1/agent/ask', {
    utterance: 'Sube mis tarifas 10% para septiembre',
    context: { propertyId: cartagena.id },
  });
  ok(
    'e-commerce may still ASK the agent for a rate change',
    ecAsk.ok && ecAsk.body.action?.command?.kind === 'update_rates',
    ecAsk.body?.action?.command?.kind,
  );
  ok(
    'the agent refuses to execute it, because the person has no rates.write',
    ecAsk.body?.action?.status === 'REJECTED' &&
      (ecAsk.body.action.policyDecision?.checks ?? []).some(
        (c) => c.code === 'PERMISSION' && !c.passed,
      ),
    (ecAsk.body?.action?.policyDecision?.checks ?? []).find((c) => c.code === 'PERMISSION')
      ?.detail,
  );

  const ecUsers = await api('GET', '/api/v1/users');
  ok('e-commerce cannot list the team', ecUsers.status === 403);

  const ecAdmin = await api('GET', '/api/v1/admin/tenants');
  ok('e-commerce cannot reach the platform administration surface', ecAdmin.status === 403);

  // The general manager administers people.
  const gm = await login('gerencia@caribehotels.co');
  ok(
    'the general manager holds users.manage',
    gm.permissions.includes('users.manage'),
    gm.role,
  );

  const team = await api('GET', '/api/v1/users');
  ok(
    'the general manager sees their own organization',
    team.ok && team.body.length >= 5,
    `${team.body?.length} people`,
  );
  ok(
    'a disabled colleague is listed rather than hidden',
    team.ok && team.body.some((u) => u.status === 'DISABLED'),
  );

  const disabledLogin = await api('POST', '/api/v1/auth/login', {
    email: 'exrevenue@caribehotels.co',
  });
  ok(
    'a disabled account cannot obtain a session',
    disabledLogin.status === 403 && /disabled/i.test(disabledLogin.body?.error?.message ?? ''),
    disabledLogin.body?.error?.message,
  );

  // Grant one permission on top of a role, and watch it resolve.
  const grant = await api('POST', '/api/v1/users', {
    email: 'ecommerce@caribehotels.co',
    name: 'Julián Mesa',
    jobTitle: 'E-commerce & Distribución',
    role: 'ECOMMERCE',
    status: 'ACTIVE',
    grants: ['promotions.write'],
    revokes: [],
    propertyIds: [],
    maxAutonomy: 1,
  });
  ok(
    'a general manager can grant a single permission without changing the role',
    grant.ok && grant.body.permissions.includes('promotions.write') && grant.body.role === 'ECOMMERCE',
    grant.ok ? `${grant.body.permissions.length} effective` : JSON.stringify(grant.body?.error),
  );

  const overreach = await api('POST', '/api/v1/users', {
    email: 'ecommerce@caribehotels.co',
    name: 'Julián Mesa',
    role: 'ECOMMERCE',
    status: 'ACTIVE',
    grants: ['platform.activity.read'],
    revokes: [],
    propertyIds: [],
    maxAutonomy: 1,
  });
  ok(
    'a hotel administrator cannot grant a platform permission to their own team',
    overreach.status === 403 &&
      /inside a hotel/i.test(overreach.body?.error?.message ?? ''),
    overreach.body?.error?.message,
  );

  const mintStaff = await api('POST', '/api/v1/users', {
    email: 'intruso@caribehotels.co',
    name: 'Intruso',
    role: 'SUPER_ADMIN',
    status: 'ACTIVE',
    grants: [],
    revokes: [],
    propertyIds: [],
    maxAutonomy: 3,
  });
  ok(
    'a hotel administrator cannot mint Wetriip staff',
    mintStaff.status === 403 && /Wetriip/i.test(mintStaff.body?.error?.message ?? ''),
    mintStaff.body?.error?.message,
  );

  // Put the analyst back where the seed left them, so this script stays
  // re-runnable — a smoke test that mutates state permanently is a trap.
  await api('POST', '/api/v1/users', {
    email: 'ecommerce@caribehotels.co',
    name: 'Julián Mesa',
    jobTitle: 'E-commerce & Distribución',
    role: 'ECOMMERCE',
    status: 'ACTIVE',
    grants: [],
    revokes: [],
    propertyIds: [],
    maxAutonomy: 1,
  });

  const gmAdmin = await api('GET', '/api/v1/admin/tenants');
  ok('a general manager cannot reach platform administration either', gmAdmin.status === 403);

  // Wetriip staff see everything.
  const ops = await login('ops@wetriip.ai');
  ok(
    'platform staff hold the cross-tenant permissions',
    ops.permissions.includes('platform.tenants.read') &&
      ops.permissions.includes('platform.activity.read'),
  );

  const tenants = await api('GET', '/api/v1/admin/tenants');
  ok(
    'platform administration lists every tenant with its counts',
    tenants.ok && tenants.body.length > 0 && tenants.body[0].users > 0,
    `${tenants.body?.length} tenant(s), ${tenants.body?.[0]?.users} users`,
  );

  const activity = await api('GET', '/api/v1/admin/activity?limit=50');
  ok(
    'every user change the hotel made is visible to Wetriip',
    activity.ok && activity.body.some((a) => a.action === 'user.updated'),
    `${activity.body?.length} recorded action(s)`,
  );

  // ── 16. Groups: block, benefits and the negotiation ──────
  console.log('\n[16] Group inventory, gratuidad and the auction');

  await login('melisa@caribehotels.co');

  // Each run creates its OWN block. An accepted group permanently commits rooms
  // — as it should — so a script that reused the seeded block would pass once
  // and then fail for the rest of its life on state it created itself.
  const seeded = await api('GET', `/api/v1/groups/blocks?propertyId=${cartagena.id}`);
  ok(
    'the seeded block declares rooms per bedding, with a physical ceiling',
    seeded.ok && seeded.body.length > 0 && seeded.body[0].capacity.lines.length >= 2,
    seeded.body?.[0]
      ? `${seeded.body[0].roomsCeiling} ceiling, ${seeded.body[0].capacity.lines.length} bedding line(s)`
      : 'none',
  );

  const workspace = await api('GET', `/api/v1/properties/${cartagena.id}/workspace`);
  const roomTypeId = workspace.body?.roomTypes?.[0]?.id;
  const blockCode = `SMOKE-${Date.now().toString().slice(-8)}`;
  const createdBlock = await api('POST', '/api/v1/groups/blocks', {
    propertyId: cartagena.id,
    code: blockCode,
    name: `Bloqueo de prueba ${blockCode}`,
    from: addDays(25),
    to: addDays(55),
    currency: 'COP',
    roomsCeiling: 20,
    releaseDays: 21,
    minRooms: 10,
    status: 'OPEN',
    notes: null,
    lines: [
      { roomTypeId, bedding: 'TWIN', roomsTotal: 18, ratePerNight: 420000 },
      { roomTypeId, bedding: 'DOUBLE', roomsTotal: 20, ratePerNight: 420000 },
    ],
  });
  ok('a revenue manager can load a group block', createdBlock.ok, blockCode);
  const block = createdBlock.body;

  const foreignRoom = await api('POST', '/api/v1/groups/blocks', {
    propertyId: cartagena.id,
    code: `${blockCode}-X`,
    name: 'Bloqueo invalido',
    from: addDays(25),
    to: addDays(55),
    currency: 'COP',
    roomsCeiling: 5,
    releaseDays: 21,
    minRooms: 2,
    status: 'DRAFT',
    notes: null,
    lines: [{ roomTypeId: 'not-a-room-of-this-hotel', bedding: 'TWIN', roomsTotal: 2, ratePerNight: null }],
  });
  ok(
    'a block cannot reference a room type from another property',
    foreignRoom.status === 400,
    foreignRoom.body?.error?.message,
  );
  ok(
    'bedding lines may sum above the ceiling, because the same rooms convert',
    block && block.lines.reduce((a, l) => a + l.roomsTotal, 0) > block.roomsCeiling,
    block ? `${block.lines.reduce((a, l) => a + l.roomsTotal, 0)} in lines vs ${block.roomsCeiling} real` : '',
  );

  const policy = await api('GET', `/api/v1/groups/policy/${cartagena.id}`);
  ok(
    'the hotel has declared a floor rate and a comp rule',
    policy.ok && policy.body.floorRatePerNight > 0 && policy.body.benefits.length > 0,
    policy.ok ? `floor ${policy.body.floorRatePerNight}, 1 per ${policy.body.benefits[0].everyNRooms}` : '',
  );

  // The agency's side: a budget, not a search.
  await login('gerencia@ctmenlinea.com.co');
  const tooSmall = await api('POST', '/api/v1/groups/requests', {
    propertyId: cartagena.id,
    blockId: block.id,
    groupName: 'Grupo pequeno',
    checkIn: addDays(30),
    checkOut: addDays(33),
    pax: 4,
    rooms: [{ bedding: 'DOUBLE', rooms: 2 }],
    budgetTotal: 3000000,
    currency: 'COP',
    inclusions: [],
    notes: null,
  });
  ok(
    'a party below the hotel group minimum is refused and told to book normally',
    tooSmall.status === 400 && /minimum for group business/i.test(tooSmall.body?.error?.message ?? ''),
    tooSmall.body?.error?.message,
  );

  const overCeiling = await api('POST', '/api/v1/groups/requests', {
    propertyId: cartagena.id,
    blockId: block.id,
    groupName: 'Grupo enorme',
    checkIn: addDays(30),
    checkOut: addDays(33),
    pax: 60,
    rooms: [
      { bedding: 'TWIN', rooms: 15 },
      { bedding: 'DOUBLE', rooms: 15 },
    ],
    budgetTotal: 40000000,
    currency: 'COP',
    inclusions: [],
    notes: null,
  });
  ok(
    'a group beyond the physical ceiling is refused, naming the ceiling',
    overCeiling.status === 409 && /ceiling of 20/.test(JSON.stringify(overCeiling.body)),
    overCeiling.body?.error?.remediation,
  );

  // 10 rooms x 3 nights at a budget that lands below the 380,000 floor.
  const groupName = `Grupo Wetriip ${Date.now().toString().slice(-6)}`;
  const request = await api('POST', '/api/v1/groups/requests', {
    propertyId: cartagena.id,
    blockId: block.id,
    groupName,
    checkIn: addDays(30),
    checkOut: addDays(33),
    pax: 20,
    rooms: [{ bedding: 'DOUBLE', rooms: 10 }],
    budgetTotal: 10000000,
    currency: 'COP',
    inclusions: ['Desayuno'],
    notes: 'Presupuesto cerrado del cliente.',
  });
  ok('an agency can raise a group request with a budget', request.ok, request.body?.id);

  const evalRound = request.body?.rounds?.[0]?.evaluation;
  ok(
    'the budget is turned into an ADR the hotel can judge',
    evalRound && evalRound.roomNights === 30 && evalRound.offeredAdr > 0,
    evalRound ? `${evalRound.roomNights} room-nights at ${evalRound.offeredAdr}` : '',
  );
  ok(
    'the shortfall against the floor is stated in money, not as a label',
    evalRound?.verdict === 'BELOW_FLOOR' && evalRound.shortfallTotal > 0,
    evalRound ? `gives up ${evalRound.shortfallTotal} COP` : '',
  );
  ok(
    'the response window is a real deadline on the row',
    request.body?.hoursRemaining > 23 && request.body?.hoursRemaining <= 24,
    `${request.body?.hoursRemaining} h remaining`,
  );

  // The hold is what stops two agencies being told yes for the same rooms.
  await login('melisa@caribehotels.co');

  // Snapshot real availability before acceptance, so the decrement can be
  // measured rather than assumed.
  const nightOne = addDays(30);
  const availBefore = await api(
    'GET',
    `/api/v1/properties/${cartagena.id}/calendar?from=${nightOne}&to=${nightOne}`,
  );
  const beforeRows = (availBefore.body ?? []).filter((c) => c.roomTypeId === roomTypeId);
  const beforeAvail = beforeRows.reduce((a, c) => a + (c.available ?? 0), 0);

  const held = await api('GET', `/api/v1/groups/blocks?propertyId=${cartagena.id}`);
  const heldDouble = held.body
    ?.find((b) => b.id === block.id)
    ?.capacity?.lines?.find((l) => l.bedding === 'DOUBLE');
  ok(
    'a live offer holds inventory while it is being negotiated',
    heldDouble && heldDouble.held >= 10,
    heldDouble ? `${heldDouble.held} DOUBLE on hold, ${heldDouble.available} left` : '',
  );

  const notifications = await api('GET', `/api/v1/groups/notifications?requestId=${request.body.id}`);
  ok(
    'the hotel is notified and the agency is named in the message',
    notifications.ok &&
      notifications.body.length > 0 &&
      /CTM En Linea/.test(notifications.body[0].body),
    `${notifications.body?.length} notification(s)`,
  );
  ok(
    'an unconfigured channel is recorded as NOT_CONFIGURED with its requirement, never as sent',
    notifications.body?.every((n) => n.status !== 'SENT') &&
      notifications.body?.some((n) => n.status === 'NOT_CONFIGURED' && n.requirement),
    notifications.body?.find((n) => n.channel === 'WHATSAPP')?.requirement?.slice(0, 60),
  );

  // The hotel counters; the clock restarts because the ball has moved.
  const counter = await api('POST', '/api/v1/groups/requests/respond', {
    requestId: request.body.id,
    decision: 'COUNTER',
    counterTotal: 12500000,
    benefitsOffered: [],
    message: 'Podemos a 12.5M con la gratuidad incluida.',
  });
  ok(
    'the hotel can counter, and the round is appended rather than edited',
    counter.ok && counter.body.status === 'COUNTERED' && counter.body.rounds.length === 2,
    `${counter.body?.rounds?.length} round(s)`,
  );
  ok(
    'the counter is evaluated against the same floor',
    counter.body?.rounds?.[1]?.evaluation?.verdict === 'ABOVE_FLOOR',
    `net ADR ${counter.body?.rounds?.[1]?.evaluation?.netAdr}`,
  );

  const selfAnswer = await api('POST', '/api/v1/groups/requests/respond', {
    requestId: request.body.id,
    decision: 'ACCEPT',
    counterTotal: null,
    benefitsOffered: [],
    message: null,
  });
  ok('the hotel can accept its own counter', selfAnswer.ok && selfAnswer.body.status === 'ACCEPTED');
  ok(
    'the settlement snapshots the arithmetic it was decided on',
    selfAnswer.body?.settlement?.netAdr > 0 && Array.isArray(selfAnswer.body.settlement.explanation),
    `net ADR ${selfAnswer.body?.settlement?.netAdr}`,
  );

  // ── The rooms must actually leave the sellable pool ─────
  ok(
    'accepting a group takes the rooms out of sale',
    selfAnswer.body?.inventoryStatus === 'APPLIED' && selfAnswer.body?.inventoryDetail?.cells > 0,
    selfAnswer.body?.inventoryDetail
      ? `${selfAnswer.body.inventoryDetail.cells} cell(s) over ${selfAnswer.body.inventoryDetail.nights} night(s)`
      : selfAnswer.body?.inventoryDetail?.reason,
  );
  ok(
    'the decrement covers the nights occupied, not the departure date',
    selfAnswer.body?.inventoryDetail?.nights === 3 &&
      selfAnswer.body?.inventoryDetail?.window?.to === addDays(32),
    `${selfAnswer.body?.inventoryDetail?.window?.from} → ${selfAnswer.body?.inventoryDetail?.window?.to}`,
  );

  const availAfter = await api(
    'GET',
    `/api/v1/properties/${cartagena.id}/calendar?from=${nightOne}&to=${nightOne}`,
  );
  const afterRows = (availAfter.body ?? []).filter((c) => c.roomTypeId === roomTypeId);
  const afterAvail = afterRows.reduce((a, c) => a + (c.available ?? 0), 0);
  // The pool absorbs what it can. Ten rooms out of a night that only published
  // two leaves zero and an eight-room shortfall — which must be REPORTED, not
  // quietly floored, because the hotel is then committed to rooms its own feed
  // does not show.
  const taken = beforeAvail - afterAvail;
  const wanted = 10 * afterRows.length;
  ok(
    'committed rooms are removed from every rate plan on that room type',
    afterRows.length > 0 && taken === Math.min(wanted, beforeAvail),
    `${beforeAvail} → ${afterAvail} across ${afterRows.length} rate plan(s)`,
  );
  ok(
    'a block that promised more than the channel manager published reports the shortfall',
    wanted <= beforeAvail
      ? selfAnswer.body?.inventoryDetail?.shortfall === 0
      : selfAnswer.body?.inventoryDetail?.shortfall > 0 &&
        /channel manager has published/i.test(
          selfAnswer.body?.inventoryDetail?.shortfallDetail ?? '',
        ),
    `shortfall ${selfAnswer.body?.inventoryDetail?.shortfall} room-night(s)`,
  );
  ok(
    'the decrement was written to MANAGED, leaving the channel manager feed intact',
    afterRows.every((c) => c.explanation?.fields?.available?.layer === 'MANAGED'),
    afterRows[0]?.explanation?.fields?.available?.layer,
  );
  ok(
    'the new availability was pushed out to the channel manager',
    selfAnswer.body?.inventoryDetail?.pushedToProvider === true,
    selfAnswer.body?.inventoryDetail?.pushDetail,
  );

  const releaseAgain = await api(
    'POST',
    `/api/v1/groups/requests/${request.body.id}/release-inventory`,
    {},
  );
  const availTwice = await api(
    'GET',
    `/api/v1/properties/${cartagena.id}/calendar?from=${nightOne}&to=${nightOne}`,
  );
  const twiceAvail = (availTwice.body ?? [])
    .filter((c) => c.roomTypeId === roomTypeId)
    .reduce((a, c) => a + (c.available ?? 0), 0);
  ok(
    'releasing twice does not subtract twice',
    releaseAgain.ok && twiceAvail === afterAvail,
    `${releaseAgain.body?.reason ?? ''} — still ${twiceAvail}`,
  );

  const reopen = await api('POST', '/api/v1/groups/requests/respond', {
    requestId: request.body.id,
    decision: 'DECLINE',
    counterTotal: null,
    benefitsOffered: [],
    message: null,
  });
  ok(
    'a settled negotiation cannot be reopened',
    reopen.status === 409 && /already ACCEPTED/.test(reopen.body?.error?.message ?? ''),
    reopen.body?.error?.message,
  );

  const committed = await api('GET', `/api/v1/groups/blocks?propertyId=${cartagena.id}`);
  const line = committed.body
    ?.find((b) => b.id === block.id)
    ?.capacity?.lines?.find((l) => l.bedding === 'DOUBLE');
  ok(
    'an accepted group moves from held to committed',
    line && line.committed >= 10,
    line ? `${line.committed} committed, ${line.held} held` : '',
  );

  // A group with no block has no room type to take the rooms from, so accepting
  // it would commit rooms nobody can withdraw.
  await login('gerencia@ctmenlinea.com.co');
  const blockless = await api('POST', '/api/v1/groups/requests', {
    propertyId: cartagena.id,
    blockId: null,
    groupName: `Grupo sin bloqueo ${Date.now().toString().slice(-6)}`,
    checkIn: addDays(30),
    checkOut: addDays(33),
    pax: 20,
    rooms: [{ bedding: 'DOUBLE', rooms: 10 }],
    budgetTotal: 14000000,
    currency: 'COP',
    inclusions: [],
    notes: null,
  });
  await login('melisa@caribehotels.co');
  const blocklessAccept = await api('POST', '/api/v1/groups/requests/respond', {
    requestId: blockless.body.id,
    decision: 'ACCEPT',
    counterTotal: null,
    benefitsOffered: [],
    message: null,
  });
  ok(
    'a group with no block cannot be accepted, because the rooms could not be withdrawn',
    blocklessAccept.status === 409 && /not attached to a block/i.test(
      blocklessAccept.body?.error?.message ?? '',
    ),
    blocklessAccept.body?.error?.remediation?.slice(0, 80),
  );

  // The agency cannot answer on the hotel's behalf, whatever its permissions say.
  await login('gerencia@ctmenlinea.com.co');
  const buyerAnswer = await api('POST', '/api/v1/groups/requests/respond', {
    requestId: request.body.id,
    decision: 'ACCEPT',
    counterTotal: null,
    benefitsOffered: [],
    message: null,
  });
  ok(
    'the agency that raised a request cannot answer it',
    buyerAnswer.status === 403 || buyerAnswer.status === 409,
    buyerAnswer.body?.error?.message,
  );

  // E-commerce reads the pipeline and cannot touch it.
  await login('ecommerce@caribehotels.co');
  const ecGroupRead = await api('GET', `/api/v1/groups/requests?propertyId=${cartagena.id}`);
  ok('e-commerce can read the group pipeline', ecGroupRead.ok);
  const ecGroupWrite = await api('POST', '/api/v1/groups/policy', {
    propertyId: cartagena.id,
    minRoomsForGroup: 2,
    floorRatePerNight: 1,
    floorCurrency: 'COP',
    autoDeclineBelowFloor: false,
    responseWindowHours: 24,
    depositPct: 0,
    cancellationPolicy: null,
    benefits: [],
    notifyEmails: [],
    notifyWhatsapp: [],
  });
  ok(
    'e-commerce cannot rewrite the group policy',
    ecGroupWrite.status === 403 && /groups\.write/.test(JSON.stringify(ecGroupWrite.body)),
    ecGroupWrite.body?.error?.message,
  );

  // ── 17. Event spaces ─────────────────────────────────────
  console.log('\n[17] Event spaces: layout, pricing unit and the quote');

  await login('melisa@caribehotels.co');
  const spaces = await api('GET', `/api/v1/event-spaces?propertyId=${cartagena.id}`);
  const salon = spaces.body?.find((s) => s.code === 'SALON-BAHIA');
  ok(
    'event spaces carry a capacity per layout, not one number',
    spaces.ok && salon && salon.layouts.length >= 4,
    salon ? salon.layouts.map((l) => `${l.label} ${l.capacity}`).join(', ') : '',
  );
  ok(
    'equipment and catering are listed separately, with prices',
    salon && salon.equipment.length > 0 && salon.catering.length > 0,
    `${salon?.equipment?.length} equipment, ${salon?.catering?.length} catering`,
  );

  const tooMany = await api('POST', '/api/v1/event-spaces/quote', {
    spaceId: salon.id,
    date: addDays(20),
    layout: 'U_SHAPE',
    pax: 80,
    hours: null,
    days: 1,
    addons: [],
  });
  ok(
    'a group that does not fit the layout is refused, with the layout that would hold it',
    tooMany.status === 400 &&
      /seats 28 in En U/.test(tooMany.body?.error?.message ?? '') &&
      /Banquete/.test(tooMany.body?.error?.remediation ?? ''),
    tooMany.body?.error?.remediation,
  );

  const halfDay = await api('POST', '/api/v1/event-spaces/quote', {
    spaceId: salon.id,
    date: addDays(20),
    layout: 'THEATRE',
    pax: 60,
    hours: 4,
    days: 1,
    addons: [],
  });
  ok(
    'the quote picks the cheapest applicable unit and says what it compared',
    halfDay.ok && halfDay.body.lines[0].unit === 'HALF_DAY',
    halfDay.body?.warnings?.[0],
  );

  const full = await api('POST', '/api/v1/event-spaces/quote', {
    spaceId: salon.id,
    date: addDays(20),
    layout: 'U_SHAPE',
    pax: 25,
    hours: 8,
    days: 2,
    addons: [
      { kind: 'VIDEOBEAM', quantity: 1 },
      { kind: 'COFFEE_BREAK', quantity: 1 },
      { kind: 'MICROPHONE', quantity: 1 },
    ],
  });
  ok(
    'the quote separates space, setup, equipment and catering',
    full.ok && full.body.spaceTotal > 0 && full.body.equipmentTotal > 0 && full.body.cateringTotal > 0,
    `space ${full.body?.spaceTotal}, equipment ${full.body?.equipmentTotal}, catering ${full.body?.cateringTotal}`,
  );
  ok(
    'a per-person item defaults to the whole room',
    full.body?.lines?.find((l) => l.label === 'Coffee break')?.quantity === 25,
    `${full.body?.lines?.find((l) => l.label === 'Coffee break')?.quantity} coffees for 25 pax`,
  );
  ok(
    'an item included with the room is listed at zero rather than hidden',
    full.body?.lines?.some((l) => l.amount === 0 && /Incluido/.test(l.explanation)),
  );
  ok(
    'every line carries the arithmetic that produced it',
    full.body?.lines?.every((l) => typeof l.explanation === 'string' && l.explanation.length > 0),
  );
  ok(
    'the property tax rules are applied, not a hard-coded rate',
    full.body?.taxPct > 0 && full.body?.taxTotal > 0,
    `${full.body?.taxPct}% = ${full.body?.taxTotal}`,
  );

  // The whole point of dictation: an agent command that lands as configuration.
  const dictated = await api('POST', '/api/v1/agent/ask', {
    utterance: 'Doy una gratuidad por cada 20 habitaciones',
    context: { propertyId: cartagena.id },
  });
  ok(
    'the assistant parses the gratuidad rule into a typed command',
    dictated.ok && dictated.body.action?.command?.kind === 'set_group_policy',
    dictated.body?.action?.command?.benefits?.[0]?.everyNRooms
      ? `1 per ${dictated.body.action.command.benefits[0].everyNRooms}`
      : dictated.body?.action?.status,
  );
  ok(
    'it still will not apply it without a human confirming',
    dictated.body?.requiresConfirmation === true,
    dictated.body?.action?.status,
  );

  console.log(`\n=== ${checks - failures}/${checks} checks passed ===\n`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nsmoke run crashed:', err);
  process.exit(1);
});
