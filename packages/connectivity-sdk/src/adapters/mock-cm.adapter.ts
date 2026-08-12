import { createHmac } from 'node:crypto';
import {
  AdapterCapabilities,
  ChannelManagerAdapter,
  ConnectionContext,
  DEFAULT_RATE_LIMIT,
  HealthResult,
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
} from '@wetriip/contracts';

/**
 * Mock channel manager.
 *
 * Not a toy. This is the certification harness the Definition of Done for a
 * real connection is measured against, and it deliberately reproduces the
 * behaviours that break integrations in production:
 *
 *   · duplicate redelivery of the same payload
 *   · events arriving out of order
 *   · timeouts on booking that resolve as UNKNOWN rather than failure
 *   · rate limiting
 *
 * Its output is deterministic from a seed, so an ARI regression is
 * reproducible instead of anecdotal.
 */
export const MOCK_CAPABILITIES: AdapterCapabilities = {
  discoverProperties: true,
  discoverRooms: true,
  discoverRatePlans: true,
  receiveAriPush: true,
  fetchAriPull: true,
  pushRate: true,
  pushAvailability: true,
  pushRestriction: true,
  createBooking: true,
  cancelBooking: true,
  modifyBooking: false,
  healthCheck: true,
  monotonicSequence: true,
  signatureScheme: 'HMAC_SHA256',
};

export interface MockBehaviour {
  /** Fraction of createBooking calls that time out into UNKNOWN. */
  unknownRate?: number;
  failureRate?: number;
  latencyMs?: number;
  seed?: number;
}

export class MockCmAdapter implements ChannelManagerAdapter {
  readonly provider: Provider = 'MOCK_CM';
  readonly capabilities = MOCK_CAPABILITIES;
  readonly rateLimit = { ...DEFAULT_RATE_LIMIT, requestsPerSecond: 50, burst: 100 };

  private seq = 0;

  constructor(private readonly behaviour: MockBehaviour = {}) {}

  /**
   * Deterministic pseudo-random in [0,1), derived from the cell's own identity
   * rather than from a running sequence.
   *
   * This matters: a generator whose value depends on iteration order produces
   * different prices for the same date depending on the window you asked for,
   * which makes replay and idempotency untestable. Same room, same plan, same
   * date, same seed -> same number, on any machine, in any order.
   */
  private noiseFor(key: string, seed: number): number {
    let h = seed >>> 0;
    for (let i = 0; i < key.length; i++) {
      h = (Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0);
    }
    h ^= h << 13;
    h >>>= 0;
    h ^= h >>> 17;
    h ^= h << 5;
    h >>>= 0;
    return (h % 10_000) / 10_000;
  }

  verifySignature(rawBody: string, headers: Record<string, string>, secret?: string): boolean {
    if (!secret) return true; // dev connections may run unsigned, on purpose
    const provided = headers['x-mock-signature'] ?? '';
    return createHmac('sha256', secret).update(rawBody).digest('hex') === provided;
  }

  async discoverProperties(ctx: ConnectionContext): Promise<RemoteProperty[]> {
    return [
      {
        remoteCode: `MOCK-${ctx.propertyId.slice(-6).toUpperCase()}`,
        name: 'Mock Property',
        city: 'Cartagena',
        country: 'CO',
        currency: 'COP',
      },
    ];
  }

  async discoverRooms(): Promise<RemoteRoom[]> {
    return [
      { remoteCode: 'DLX', name: 'Deluxe King', maxOccupancy: 2 },
      { remoteCode: 'JSU', name: 'Junior Suite', maxOccupancy: 3 },
      { remoteCode: 'STD', name: 'Standard Twin', maxOccupancy: 2 },
    ];
  }

  async discoverRatePlans(): Promise<RemoteRatePlan[]> {
    return [
      { remoteCode: 'BAR', name: 'Best Available Rate', mealPlan: 'RO', currency: 'COP' },
      { remoteCode: 'BARBB', name: 'BAR Bed & Breakfast', mealPlan: 'BB', currency: 'COP' },
      { remoteCode: 'NREF', name: 'Non Refundable', mealPlan: 'RO', currency: 'COP' },
    ];
  }

  parsePush(payload: unknown, ctx: ConnectionContext, resolve: MappingResolver): NormalizedAriEvent[] {
    const p = payload as {
      sentAt?: string;
      sequence?: number;
      rows?: Array<{
        room: string;
        rate: string;
        date: string;
        price?: number;
        currency?: string;
        rooms?: number;
        open?: boolean;
        minLos?: number;
        cta?: boolean;
      }>;
    };
    const sentAt = new Date(p.sentAt ?? Date.now());
    return (p.rows ?? []).flatMap((row) => {
      const roomTypeId = resolve.roomTypeId(row.room);
      const ratePlanId = resolve.ratePlanId(row.rate);
      if (!roomTypeId || !ratePlanId) return [];
      return [
        NormalizedAriEventSchema.parse({
          tenantId: resolve.tenantId(),
          propertyId: resolve.propertyId(),
          roomTypeId,
          ratePlanId,
          stayDate: row.date,
          occupancy: 2,
          layer: 'EXTERNAL',
          eventType: row.price != null ? 'RATE_UPDATED' : 'AVAILABILITY_UPDATED',
          source: `MOCK_CM:${ctx.connectionId}`,
          sourceSequence: p.sequence ?? ++this.seq,
          sourceTimestamp: sentAt,
          values: {
            ...(row.price != null ? { baseAmount: row.price, currency: row.currency ?? 'COP' } : {}),
            ...(row.rooms != null ? { available: row.rooms, allotment: row.rooms } : {}),
            ...(row.open !== undefined ? { open: row.open } : {}),
            ...(row.minLos !== undefined ? { minLos: row.minLos } : {}),
            ...(row.cta !== undefined ? { closedToArrival: row.cta } : {}),
          },
          mappingVersion: resolve.version,
          correlationId: ctx.correlationId,
        }),
      ];
    });
  }

  /**
   * Deterministic inventory generator: weekend uplift, a scripted stale gap and
   * a scripted closed-to-arrival block, so demos and tests exercise the
   * diagnostic paths rather than a uniformly healthy hotel nobody learns from.
   */
  async fetchAri(
    ctx: ConnectionContext,
    window: PullWindow,
    resolve: MappingResolver,
  ): Promise<PullResult> {
    const seed = (this.behaviour.seed ?? 42) + ctx.connectionId.length;
    const rooms = await this.discoverRooms();
    const plans = await this.discoverRatePlans();
    const dates = dateRange(window.from, window.to);
    const now = new Date();
    const events: NormalizedAriEvent[] = [];

    for (const room of rooms) {
      const roomTypeId = resolve.roomTypeId(room.remoteCode);
      if (!roomTypeId) continue;
      // Scripted failure: Junior Suite stops receiving inventory entirely.
      const silentRoom = room.remoteCode === 'JSU';

      for (const plan of plans) {
        const ratePlanId = resolve.ratePlanId(plan.remoteCode);
        if (!ratePlanId) continue;

        for (const stayDate of dates) {
          if (silentRoom) continue;
          const dow = new Date(`${stayDate}T00:00:00Z`).getUTCDay();
          const weekend = dow === 5 || dow === 6;
          const base = room.remoteCode === 'DLX' ? 620_000 : 430_000;
          const planFactor = plan.remoteCode === 'NREF' ? 0.88 : plan.remoteCode === 'BARBB' ? 1.15 : 1;
          const noise = 0.9 + this.noiseFor(`${room.remoteCode}|${plan.remoteCode}|${stayDate}`, seed) * 0.2;
          const price = Math.round(base * planFactor * (weekend ? 1.25 : 1) * noise);

          events.push(
            NormalizedAriEventSchema.parse({
              tenantId: resolve.tenantId(),
              propertyId: resolve.propertyId(),
              roomTypeId,
              ratePlanId,
              stayDate,
              occupancy: 2,
              layer: 'EXTERNAL',
              eventType: 'FULL_SYNC',
              source: `MOCK_CM:${ctx.connectionId}`,
              sourceSequence: ++this.seq,
              sourceTimestamp: now,
              values: {
                currency: 'COP',
                baseAmount: price,
                available: weekend ? 2 : 6,
                allotment: weekend ? 2 : 6,
                open: true,
                stopSell: false,
                // Scripted CTA on weekends for the BAR plan: this is the
                // condition the diagnostic agent is expected to surface.
                closedToArrival: weekend && plan.remoteCode === 'BAR',
                closedToDeparture: false,
                minLos: weekend ? 2 : 1,
                releaseDays: 0,
                bookingGap: 0,
              },
              mappingVersion: resolve.version,
              correlationId: ctx.correlationId,
            }),
          );
        }
      }
    }

    return { events, nextCursor: window.to, hasMore: false };
  }

  async pushAri(_ctx: ConnectionContext, commands: PushAriCommand[]) {
    return { accepted: commands.length, rejected: 0, detail: 'mock accepted all' };
  }

  async createBooking(
    _ctx: ConnectionContext,
    cmd: SupplierBookingCommand,
  ): Promise<SupplierBookingResult> {
    if (this.behaviour.latencyMs) await new Promise((r) => setTimeout(r, this.behaviour.latencyMs));
    const roll = this.noiseFor(cmd.idempotencyKey, 7919);
    if (roll < (this.behaviour.unknownRate ?? 0)) {
      // The important case: we do not know. Never collapse this into failure.
      return { outcome: 'UNKNOWN', message: 'supplier timed out before acknowledging' };
    }
    if (roll < (this.behaviour.unknownRate ?? 0) + (this.behaviour.failureRate ?? 0)) {
      return { outcome: 'REJECTED', message: 'no allotment at supplier' };
    }
    return {
      outcome: 'CONFIRMED',
      supplierReference: `MOCK-${cmd.bookingReference}`,
      raw: { echoed: cmd.roomRemoteCode },
    };
  }

  async cancelBooking(_ctx: ConnectionContext, supplierReference: string): Promise<SupplierBookingResult> {
    return { outcome: 'CONFIRMED', supplierReference, message: 'cancelled' };
  }

  async modifyBooking(): Promise<SupplierBookingResult> {
    return { outcome: 'REJECTED', message: 'MOCK_CM does not support modification' };
  }

  async healthCheck(ctx: ConnectionContext): Promise<HealthResult> {
    return {
      ok: true,
      latencyMs: this.behaviour.latencyMs ?? 5,
      detail: 'mock connection healthy',
      capabilities: this.capabilities,
      diagnostics: { connectionId: ctx.connectionId, seq: this.seq },
    };
  }
}
