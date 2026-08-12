import {
  AdapterCapabilities,
  ChannelManagerAdapter,
  ConnectionContext,
  DEFAULT_RATE_LIMIT,
  DomainError,
  HealthResult,
  MappingResolver,
  NormalizedAriEvent,
  Provider,
  PullResult,
  PullWindow,
  PushAriCommand,
  RateLimitPolicy,
  RemoteProperty,
  RemoteRatePlan,
  RemoteRoom,
  SupplierBookingCommand,
  SupplierBookingResult,
} from '@wetriip/contracts';

/**
 * Placeholder adapters for providers we have NOT integrated yet.
 *
 * They exist so the platform can show the real onboarding state instead of
 * pretending: the provider appears in the registry, declares the capabilities
 * we expect to negotiate, and fails every operation with an explicit
 * NOT_IMPLEMENTED plus the certification checklist that has to be completed.
 *
 * This is deliberate. A stub that silently returns empty results is how a
 * hotel ends up "connected" to a channel manager that has never sent a byte.
 * Nothing here can be enabled by accident: `healthCheck` reports ok:false.
 */
export interface PendingAdapterSpec {
  provider: Provider;
  expectedCapabilities: Partial<AdapterCapabilities>;
  rateLimit?: RateLimitPolicy;
  /** What must be true before this adapter can be marked certified. */
  certificationChecklist: string[];
  docsUrl?: string;
}

export class PendingAdapter implements ChannelManagerAdapter {
  readonly provider: Provider;
  readonly capabilities: AdapterCapabilities;
  readonly rateLimit: RateLimitPolicy;

  constructor(private readonly spec: PendingAdapterSpec) {
    this.provider = spec.provider;
    this.rateLimit = spec.rateLimit ?? DEFAULT_RATE_LIMIT;
    this.capabilities = {
      ...BASE_CAPABILITIES,
      ...spec.expectedCapabilities,
      // Every operational capability stays false until certification passes,
      // whatever the spec says we expect to negotiate. This spread is last on
      // purpose: it is the gate, not a default.
      ...FORCED_OFF,
    };
  }

  private fail(op: string): never {
    throw new DomainError({
      code: 'NOT_IMPLEMENTED',
      message: `${this.provider} adapter is not implemented yet (${op}).`,
      owner: 'Connectivity',
      remediation: `Implement the adapter and complete certification: ${this.spec.certificationChecklist.join(' · ')}`,
      details: {
        provider: this.provider,
        expectedCapabilities: this.spec.expectedCapabilities,
        checklist: this.spec.certificationChecklist,
        docs: this.spec.docsUrl,
      },
    });
  }

  verifySignature(): boolean {
    return false;
  }
  parsePush(_p: unknown, _c: ConnectionContext, _r: MappingResolver): NormalizedAriEvent[] {
    this.fail('parsePush');
  }
  async discoverProperties(): Promise<RemoteProperty[]> {
    this.fail('discoverProperties');
  }
  async discoverRooms(): Promise<RemoteRoom[]> {
    this.fail('discoverRooms');
  }
  async discoverRatePlans(): Promise<RemoteRatePlan[]> {
    this.fail('discoverRatePlans');
  }
  async fetchAri(_c: ConnectionContext, _w: PullWindow): Promise<PullResult> {
    this.fail('fetchAri');
  }
  async pushAri(
    _c: ConnectionContext,
    _cmds: PushAriCommand[],
  ): Promise<{ accepted: number; rejected: number; detail?: string }> {
    this.fail('pushAri');
  }
  async createBooking(_c: ConnectionContext, _b: SupplierBookingCommand): Promise<SupplierBookingResult> {
    this.fail('createBooking');
  }
  async cancelBooking(): Promise<SupplierBookingResult> {
    this.fail('cancelBooking');
  }
  async modifyBooking(): Promise<SupplierBookingResult> {
    this.fail('modifyBooking');
  }

  async healthCheck(): Promise<HealthResult> {
    return {
      ok: false,
      latencyMs: 0,
      detail: `${this.provider} is registered but not certified. ${this.spec.certificationChecklist.length} checklist item(s) outstanding.`,
      capabilities: this.capabilities,
      diagnostics: { checklist: this.spec.certificationChecklist, docs: this.spec.docsUrl },
    };
  }
}

const BASE_CAPABILITIES: AdapterCapabilities = {
  discoverProperties: false,
  discoverRooms: false,
  discoverRatePlans: false,
  receiveAriPush: false,
  fetchAriPull: false,
  pushRate: false,
  pushAvailability: false,
  pushRestriction: false,
  createBooking: false,
  cancelBooking: false,
  modifyBooking: false,
  healthCheck: true,
  monotonicSequence: false,
  signatureScheme: 'NONE',
};

const FORCED_OFF = {
  discoverProperties: false,
  discoverRooms: false,
  discoverRatePlans: false,
  receiveAriPush: false,
  fetchAriPull: false,
  pushRate: false,
  pushAvailability: false,
  pushRestriction: false,
  createBooking: false,
  cancelBooking: false,
  modifyBooking: false,
} as const;

/** The standard Definition of Done for any channel-manager connection,
 *  lifted from the audit so it cannot be quietly shortened. */
export const STANDARD_CERTIFICATION_CHECKLIST = [
  'Catalog discovered and mapped under an approved mapping version',
  'Push/Pull capabilities documented per operation, not as a generic label',
  'Rotatable credentials and a non-destructive health check',
  'Test ARI received, normalized, materialized and visible in UI and API',
  'Reconciliation demonstrates convergence and recovery after a replay',
  'Search returns the correct offer and explains its rules',
  'Certification booking and cancellation complete with no double effect',
  'Dashboards, alerts, runbooks and an on-call owner defined',
  'Commercial contract and permissions in force',
  'Privacy and security review approved',
];

export function createPendingAdapters(): PendingAdapter[] {
  return [
    new PendingAdapter({
      provider: 'SITEMINDER',
      expectedCapabilities: {
        receiveAriPush: true,
        fetchAriPull: true,
        pushRate: true,
        pushAvailability: true,
        pushRestriction: true,
        createBooking: true,
        cancelBooking: true,
        monotonicSequence: false,
        signatureScheme: 'HMAC_SHA256',
      },
      certificationChecklist: STANDARD_CERTIFICATION_CHECKLIST,
    }),
    new PendingAdapter({
      provider: 'DINGUS',
      expectedCapabilities: {
        receiveAriPush: true,
        fetchAriPull: true,
        createBooking: true,
        cancelBooking: true,
        signatureScheme: 'BEARER',
      },
      certificationChecklist: STANDARD_CERTIFICATION_CHECKLIST,
    }),
    new PendingAdapter({
      provider: 'CLOUDBEDS',
      expectedCapabilities: {
        discoverProperties: true,
        discoverRooms: true,
        discoverRatePlans: true,
        fetchAriPull: true,
        createBooking: true,
        signatureScheme: 'BEARER',
      },
      certificationChecklist: STANDARD_CERTIFICATION_CHECKLIST,
    }),
    new PendingAdapter({
      provider: 'DERBYSOFT',
      expectedCapabilities: {
        receiveAriPush: true,
        createBooking: true,
        cancelBooking: true,
        modifyBooking: true,
        signatureScheme: 'MTLS',
      },
      certificationChecklist: STANDARD_CERTIFICATION_CHECKLIST,
    }),
  ];
}
