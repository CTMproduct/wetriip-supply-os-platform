import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  AdapterCapabilities,
  ChannelManagerAdapter,
  ConnectionContext,
  DEFAULT_RATE_LIMIT,
  DomainError,
  MappingResolver,
  NormalizedAriEvent,
  NormalizedAriEventSchema,
  Provider,
  PullResult,
  PullWindow,
  PushAriCommand,
  RemoteProperty,
  RemoteRatePlan,
  RemoteRoom,
  SupplierBookingCommand,
  SupplierBookingResult,
  dateRange,
  HealthResult,
} from '@wetriip/contracts';

/**
 * Canonical JSON adapter.
 *
 * The house dialect. A provider that is willing to post our schema — or a
 * partner-side translator that already speaks it — connects through this one
 * without any bespoke code on our side.
 *
 * It is also the reference implementation: every provider adapter's parsePush
 * must produce exactly what this one produces for the equivalent input, which
 * is what the conformance suite checks.
 */
export const CANONICAL_CAPABILITIES: AdapterCapabilities = {
  discoverProperties: false,
  discoverRooms: false,
  discoverRatePlans: false,
  receiveAriPush: true,
  fetchAriPull: false,
  pushRate: false,
  pushAvailability: false,
  pushRestriction: false,
  createBooking: false,
  cancelBooking: false,
  modifyBooking: false,
  healthCheck: true,
  monotonicSequence: true,
  signatureScheme: 'HMAC_SHA256',
};

interface CanonicalUpdate {
  roomCode: string;
  ratePlanCode: string;
  from: string;
  to?: string;
  occupancy?: number;
  rate?: { currency: string; amount: number };
  availability?: number;
  restrictions?: {
    open?: boolean;
    stopSell?: boolean;
    cta?: boolean;
    ctd?: boolean;
    minLos?: number;
    maxLos?: number;
    release?: number;
    bookingGap?: number;
  };
}

interface CanonicalPayload {
  propertyCode?: string;
  sentAt: string;
  sequence?: number;
  updates: CanonicalUpdate[];
}

export class CanonicalJsonAdapter implements ChannelManagerAdapter {
  readonly provider: Provider = 'CANONICAL_JSON';
  readonly capabilities = CANONICAL_CAPABILITIES;
  readonly rateLimit = DEFAULT_RATE_LIMIT;

  verifySignature(rawBody: string, headers: Record<string, string>, secret?: string): boolean {
    if (!secret) return false;
    const provided = headers['x-wetriip-signature'] ?? headers['X-Wetriip-Signature'] ?? '';
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  parsePush(payload: unknown, ctx: ConnectionContext, resolve: MappingResolver): NormalizedAriEvent[] {
    const p = payload as CanonicalPayload;
    if (!p || !Array.isArray(p.updates)) {
      throw new DomainError({
        code: 'VALIDATION',
        message: 'Canonical payload must contain an updates array',
        owner: 'Connectivity',
        correlationId: ctx.correlationId,
      });
    }
    const sentAt = new Date(p.sentAt);
    if (Number.isNaN(sentAt.getTime())) {
      throw new DomainError({
        code: 'VALIDATION',
        message: 'Canonical payload sentAt is not a valid timestamp',
        owner: 'Connectivity',
        correlationId: ctx.correlationId,
      });
    }

    const events: NormalizedAriEvent[] = [];
    for (const u of p.updates) {
      const roomTypeId = resolve.roomTypeId(u.roomCode);
      const ratePlanId = resolve.ratePlanId(u.ratePlanCode);
      if (!roomTypeId || !ratePlanId) {
        // Unmapped codes are a mapping problem, not an ARI problem. Rejecting
        // loudly here keeps unattributable inventory out of the ledger.
        throw new DomainError({
          code: 'INCOMPLETE_MAPPING',
          message: `Unmapped remote code: ${!roomTypeId ? `room ${u.roomCode}` : `rate plan ${u.ratePlanCode}`}`,
          owner: 'Catalog',
          remediation: 'Add the code to the active mapping version and publish it.',
          details: { roomCode: u.roomCode, ratePlanCode: u.ratePlanCode, mappingVersion: resolve.version },
          correlationId: ctx.correlationId,
        });
      }

      const dates = dateRange(u.from, u.to ?? u.from);
      const r = u.restrictions ?? {};
      const hasRate = u.rate != null;
      const hasAvail = u.availability != null;
      const hasRestriction = Object.keys(r).length > 0;

      for (const stayDate of dates) {
        events.push(
          NormalizedAriEventSchema.parse({
            tenantId: resolve.tenantId(),
            propertyId: resolve.propertyId(),
            roomTypeId,
            ratePlanId,
            stayDate,
            occupancy: u.occupancy ?? 2,
            layer: 'EXTERNAL',
            eventType: hasRate
              ? 'RATE_UPDATED'
              : hasAvail
                ? 'AVAILABILITY_UPDATED'
                : hasRestriction
                  ? 'RESTRICTION_UPDATED'
                  : 'FULL_SYNC',
            source: `${ctx.provider}:${ctx.connectionId}`,
            sourceSequence: p.sequence ?? null,
            sourceTimestamp: sentAt,
            values: {
              ...(hasRate ? { currency: u.rate!.currency, baseAmount: u.rate!.amount } : {}),
              ...(hasAvail ? { available: u.availability, allotment: u.availability } : {}),
              ...(r.open !== undefined ? { open: r.open } : {}),
              ...(r.stopSell !== undefined ? { stopSell: r.stopSell } : {}),
              ...(r.cta !== undefined ? { closedToArrival: r.cta } : {}),
              ...(r.ctd !== undefined ? { closedToDeparture: r.ctd } : {}),
              ...(r.minLos !== undefined ? { minLos: r.minLos } : {}),
              ...(r.maxLos !== undefined ? { maxLos: r.maxLos } : {}),
              ...(r.release !== undefined ? { releaseDays: r.release } : {}),
              ...(r.bookingGap !== undefined ? { bookingGap: r.bookingGap } : {}),
            },
            mappingVersion: resolve.version,
            correlationId: ctx.correlationId,
            actorType: 'CONNECTOR',
          }),
        );
      }
    }
    return events;
  }

  async discoverProperties(): Promise<RemoteProperty[]> {
    return notSupported('discoverProperties');
  }
  async discoverRooms(): Promise<RemoteRoom[]> {
    return notSupported('discoverRooms');
  }
  async discoverRatePlans(): Promise<RemoteRatePlan[]> {
    return notSupported('discoverRatePlans');
  }
  async fetchAri(_c: ConnectionContext, _w: PullWindow): Promise<PullResult> {
    return notSupported('fetchAri');
  }
  async pushAri(_c: ConnectionContext, _cmds: PushAriCommand[]) {
    return notSupported('pushAri');
  }
  async createBooking(_c: ConnectionContext, _b: SupplierBookingCommand): Promise<SupplierBookingResult> {
    return notSupported('createBooking');
  }
  async cancelBooking(): Promise<SupplierBookingResult> {
    return notSupported('cancelBooking');
  }
  async modifyBooking(): Promise<SupplierBookingResult> {
    return notSupported('modifyBooking');
  }

  async healthCheck(ctx: ConnectionContext): Promise<HealthResult> {
    return {
      ok: true,
      latencyMs: 0,
      detail: 'Push-only connection; health is measured by inbound event freshness.',
      capabilities: this.capabilities,
      diagnostics: { connectionId: ctx.connectionId, signatureScheme: this.capabilities.signatureScheme },
    };
  }
}

function notSupported(op: string): never {
  throw new DomainError({
    code: 'NOT_IMPLEMENTED',
    message: `CANONICAL_JSON is a push-only inbound dialect; ${op} is not part of it.`,
    owner: 'Connectivity',
    remediation: 'Use a provider adapter that declares this capability.',
  });
}
