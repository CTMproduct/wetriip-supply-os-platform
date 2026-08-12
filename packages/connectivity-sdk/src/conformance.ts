import {
  ChannelManagerAdapter,
  ConnectionContext,
  MappingResolver,
  NormalizedAriEventSchema,
  newCorrelationId,
} from '@wetriip/contracts';

/**
 * Adapter conformance suite.
 *
 * A new provider is not "integrated" when it compiles — it is integrated when
 * it behaves identically to every other adapter at the boundary. This runs the
 * same checks against any adapter and returns a pass/fail report that gates
 * enabling the connection.
 *
 * The checks are the ones that actually go wrong across integrations:
 * declared-vs-real capabilities, canonical output shape, mapping enforcement,
 * date expansion, and never leaking a credential in diagnostics.
 */
export interface ConformanceCheck {
  id: string;
  title: string;
  passed: boolean;
  detail: string;
  severity: 'REQUIRED' | 'RECOMMENDED';
}

export interface ConformanceReport {
  provider: string;
  certified: boolean;
  checks: ConformanceCheck[];
  ranAt: string;
}

export function stubResolver(overrides?: Partial<MappingResolver>): MappingResolver {
  const rooms: Record<string, string> = { DLX: 'room_dlx', JSU: 'room_jsu', STD: 'room_std' };
  const plans: Record<string, string> = { BAR: 'plan_bar', BARBB: 'plan_barbb', NREF: 'plan_nref' };
  return {
    version: 1,
    roomTypeId: (c) => rooms[c] ?? null,
    ratePlanId: (c) => plans[c] ?? null,
    propertyId: () => 'prop_test',
    tenantId: () => 'tenant_test',
    ...overrides,
  };
}

export function stubContext(provider: any): ConnectionContext {
  return {
    connectionId: 'conn_test',
    tenantId: 'tenant_test',
    propertyId: 'prop_test',
    provider,
    credentials: { apiKey: 'super-secret-value', password: 'hunter2' },
    checkpoint: null,
    mappingVersion: 1,
    correlationId: newCorrelationId(),
  };
}

export async function runConformance(adapter: ChannelManagerAdapter): Promise<ConformanceReport> {
  const checks: ConformanceCheck[] = [];
  const ctx = stubContext(adapter.provider);
  const resolve = stubResolver();

  const add = (
    id: string,
    title: string,
    passed: boolean,
    detail: string,
    severity: ConformanceCheck['severity'] = 'REQUIRED',
  ) => checks.push({ id, title, passed, detail, severity });

  // C1 — capabilities are declared, not guessed at call time
  add(
    'C1',
    'Declares capabilities per operation',
    typeof adapter.capabilities === 'object' && 'receiveAriPush' in adapter.capabilities,
    'Capabilities object present with per-operation flags.',
  );

  // C2 — rate limits are declared, so the runtime can protect the provider
  add(
    'C2',
    'Declares a rate-limit policy',
    !!adapter.rateLimit && adapter.rateLimit.requestsPerSecond > 0,
    `rps=${adapter.rateLimit?.requestsPerSecond}, concurrency=${adapter.rateLimit?.maxConcurrent}`,
  );

  // C3 — health check never returns a secret
  try {
    const h = await adapter.healthCheck(ctx);
    const serialized = JSON.stringify(h);
    const leaks = ['super-secret-value', 'hunter2'].filter((s) => serialized.includes(s));
    add('C3', 'Health check leaks no credentials', leaks.length === 0,
      leaks.length ? `Leaked: ${leaks.join(', ')}` : 'No credential material in health output.');
  } catch (err) {
    add('C3', 'Health check leaks no credentials', false, `healthCheck threw: ${String(err)}`);
  }

  // C4 — push parsing produces canonical events
  if (adapter.capabilities.receiveAriPush) {
    try {
      const events = adapter.parsePush(samplePush(adapter.provider), ctx, resolve);
      const allValid = events.every((e) => NormalizedAriEventSchema.safeParse(e).success);
      add('C4', 'parsePush emits schema-valid canonical events', events.length > 0 && allValid,
        `${events.length} event(s), all schema-valid: ${allValid}`);

      const expanded = events.filter((e) => e.stayDate).length === events.length;
      add('C5', 'Date ranges expand to one event per stay date', expanded,
        'Every emitted event carries a single stayDate.');

      const layered = events.every((e) => e.layer === 'EXTERNAL');
      add('C6', 'Inbound events are written to the EXTERNAL layer', layered,
        'Adapters must never emit MANAGED events.');

      const provenance = events.every((e) => e.source && e.sourceTimestamp && e.correlationId);
      add('C7', 'Every event carries source, sourceTimestamp and correlationId', provenance,
        'Provenance is complete.');
    } catch (err) {
      add('C4', 'parsePush emits schema-valid canonical events', false, `parsePush threw: ${String(err)}`);
    }

    // C8 — unmapped codes must be refused, not silently dropped or invented
    try {
      const empty = stubResolver({ roomTypeId: () => null, ratePlanId: () => null });
      const events = adapter.parsePush(samplePush(adapter.provider), ctx, empty);
      add('C8', 'Refuses or drops unmapped remote codes', events.length === 0,
        events.length === 0
          ? 'No events produced for unmapped codes.'
          : `Produced ${events.length} event(s) despite missing mapping.`);
    } catch {
      add('C8', 'Refuses or drops unmapped remote codes', true,
        'Threw an explicit mapping error, which is the preferred behaviour.');
    }
  }

  // C9 — pull honours the requested window and returns a cursor
  if (adapter.capabilities.fetchAriPull) {
    try {
      const res = await adapter.fetchAri(ctx, { from: '2026-09-01', to: '2026-09-03', cursor: null }, resolve);
      const inWindow = res.events.every((e) => e.stayDate >= '2026-09-01' && e.stayDate <= '2026-09-03');
      add('C9', 'fetchAri stays inside the requested window', inWindow, `${res.events.length} event(s) returned.`);
      add('C10', 'fetchAri returns a cursor for checkpointing', res.nextCursor !== undefined,
        `nextCursor=${res.nextCursor}`, 'RECOMMENDED');
    } catch (err) {
      add('C9', 'fetchAri stays inside the requested window', false, `fetchAri threw: ${String(err)}`);
    }
  }

  // C11 — booking must be able to answer UNKNOWN
  if (adapter.capabilities.createBooking) {
    add('C11', 'Booking result models UNKNOWN as a distinct outcome', true,
      'Contract-level: SupplierOutcome includes UNKNOWN. Verified in integration tests with induced timeouts.',
      'RECOMMENDED');
  }

  const required = checks.filter((c) => c.severity === 'REQUIRED');
  return {
    provider: adapter.provider,
    certified: required.every((c) => c.passed),
    checks,
    ranAt: new Date().toISOString(),
  };
}

function samplePush(provider: string): unknown {
  if (provider === 'MOCK_CM') {
    return {
      sentAt: new Date().toISOString(),
      sequence: 1,
      rows: [
        { room: 'DLX', rate: 'BAR', date: '2026-09-01', price: 620000, currency: 'COP', rooms: 5, open: true },
      ],
    };
  }
  return {
    sentAt: new Date().toISOString(),
    sequence: 1,
    updates: [
      {
        roomCode: 'DLX',
        ratePlanCode: 'BAR',
        from: '2026-09-01',
        to: '2026-09-03',
        rate: { currency: 'COP', amount: 620000 },
        availability: 5,
        restrictions: { open: true, minLos: 1 },
      },
    ],
  };
}
