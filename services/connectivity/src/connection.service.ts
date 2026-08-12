import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { EventBus } from '@wetriip/bus';
import { AdapterRegistry, ConnectionRuntime } from '@wetriip/connectivity-sdk';
import {
  ConnectionContext,
  ConnectionHealthSnapshot,
  DomainError,
  Provider,
  PullWindow,
  addDays,
  newCorrelationId,
  sha256,
  toStayDate,
} from '@wetriip/contracts';
import { Logger, M, metrics } from '@wetriip/observability';
import { AuditLog } from '@wetriip/persistence';
import {
  AUDIT_LOG,
  EVENT_BUS,
  LOGGER,
  PRISMA,
  RequestContext,
  clients,
  systemContext,
} from '@wetriip/service-kit';
import { MappingService } from './mapping.service';

/**
 * Connection lifecycle and the two transports.
 *
 * Push and Pull here are the SOURCE plane only — channel manager to platform.
 * The demand plane (platform to buyer) lives in search and distribution and
 * shares nothing with this file. Conflating the two is the design error the
 * audit called out, and keeping them in separate services makes it hard to
 * make by accident.
 */
@Injectable()
export class ConnectionService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(LOGGER) private readonly log: Logger,
    @Inject('ADAPTER_REGISTRY') private readonly registry: AdapterRegistry,
    @Inject('CONNECTION_RUNTIME') private readonly runtime: ConnectionRuntime,
    private readonly mapping: MappingService,
  ) {}

  async list(ctx: RequestContext, propertyId?: string) {
    return this.prisma.connection.findMany({
      where: { tenantId: ctx.tenantId, ...(propertyId ? { propertyId } : {}) },
      orderBy: { createdAt: 'asc' },
      include: { property: { select: { name: true, code: true } } },
    });
  }

  async require(ctx: RequestContext, connectionId: string) {
    const conn = await this.prisma.connection.findFirst({
      where: { id: connectionId, tenantId: ctx.tenantId },
    });
    if (!conn) {
      throw new DomainError({
        code: 'NOT_FOUND',
        message: `Connection ${connectionId} not found`,
        owner: 'Connectivity',
      });
    }
    return conn;
  }

  /**
   * Credentials are resolved from a vault reference at call time and never
   * persisted in the connection row, logged, or returned by any endpoint.
   * The development resolver reads process env by convention.
   */
  private resolveCredentials(credentialsRef: string | null): Record<string, string> {
    if (!credentialsRef) return {};
    const prefix = `CRED_${credentialsRef.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_`;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith(prefix) && v) out[k.slice(prefix.length).toLowerCase()] = v;
    }
    return out;
  }

  private contextFor(conn: any, correlationId: string, mappingVersion?: number | null): ConnectionContext {
    return {
      connectionId: conn.id,
      tenantId: conn.tenantId,
      propertyId: conn.propertyId,
      provider: conn.provider as Provider,
      credentials: this.resolveCredentials(conn.credentialsRef),
      checkpoint: conn.checkpoint ?? null,
      mappingVersion: mappingVersion ?? null,
      correlationId,
    };
  }

  // ── Discovery ────────────────────────────────────────────

  async discover(ctx: RequestContext, connectionId: string) {
    const conn = await this.require(ctx, connectionId);
    const adapter = this.registry.get(conn.provider as Provider);
    this.registry.assertCapability(conn.provider as Provider, 'discoverRooms');

    const cctx = this.contextFor(conn, ctx.correlationId);
    const [rooms, ratePlans] = await Promise.all([
      this.runtime.execute(cctx, adapter.rateLimit, 'discoverRooms', () => adapter.discoverRooms(cctx)),
      this.runtime.execute(cctx, adapter.rateLimit, 'discoverRatePlans', () =>
        adapter.discoverRatePlans(cctx),
      ),
    ]);

    // Candidate mapping by exact code match. Anything unmatched is surfaced
    // for a human rather than guessed at — a fuzzy room match is a wrong sale.
    const catalog = await this.prisma.property.findUnique({
      where: { id: conn.propertyId },
      include: { roomTypes: true, ratePlans: true },
    });

    return {
      rooms: rooms.map((r) => ({
        ...r,
        candidateLocalId: catalog?.roomTypes.find((x) => x.code === r.remoteCode)?.id ?? null,
      })),
      ratePlans: ratePlans.map((p) => ({
        ...p,
        candidateLocalId: catalog?.ratePlans.find((x) => x.code === p.remoteCode)?.id ?? null,
      })),
      unmatched: {
        rooms: rooms.filter((r) => !catalog?.roomTypes.some((x) => x.code === r.remoteCode)).length,
        ratePlans: ratePlans.filter((p) => !catalog?.ratePlans.some((x) => x.code === p.remoteCode))
          .length,
      },
    };
  }

  // ── Push (inbound webhook) ───────────────────────────────

  /**
   * Inbound ARI from a provider.
   *
   * The raw envelope is persisted BEFORE interpretation. If parsing then fails,
   * we still hold exactly what they sent, hashed, and can replay it once the
   * mapping or the adapter is fixed. Losing the payload and keeping only the
   * error is how integrations become unfalsifiable.
   */
  async receivePush(args: {
    connectionId: string;
    rawBody: string;
    payload: unknown;
    headers: Record<string, string>;
    idempotencyKey?: string | null;
  }) {
    const conn = await this.prisma.connection.findUnique({ where: { id: args.connectionId } });
    if (!conn) {
      throw new DomainError({
        code: 'NOT_FOUND',
        message: 'Unknown connection',
        owner: 'Connectivity',
      });
    }

    const correlationId = args.headers['x-correlation-id'] ?? newCorrelationId();
    const adapter = this.registry.get(conn.provider as Provider);
    const payloadHash = sha256(args.rawBody);

    const signatureValid = adapter.verifySignature(args.rawBody, args.headers, conn.webhookSecret ?? undefined);

    const envelope = await this.prisma.rawEnvelope.create({
      data: {
        connectionId: conn.id,
        direction: 'INBOUND',
        payload: args.payload as any,
        payloadHash,
        idempotencyKey: args.idempotencyKey ?? null,
        correlationId,
        signatureValid,
        outcome: 'ACCEPTED',
      },
    });

    if (!signatureValid && adapter.capabilities.signatureScheme !== 'NONE') {
      await this.prisma.rawEnvelope.update({
        where: { id: envelope.id },
        data: { outcome: 'REJECTED', rejectReason: 'signature verification failed' },
      });
      throw new DomainError({
        code: 'PERMISSION',
        message: 'Signature verification failed',
        owner: 'Connectivity',
        remediation: 'Check the shared secret and that the provider signs the exact raw body.',
        correlationId,
      });
    }

    const mapping = await this.mapping.activeMapping(conn.id);
    if (!mapping) {
      await this.prisma.rawEnvelope.update({
        where: { id: envelope.id },
        data: { outcome: 'REJECTED', rejectReason: 'no active mapping version' },
      });
      throw new DomainError({
        code: 'INCOMPLETE_MAPPING',
        message: 'Connection has no active mapping version',
        owner: 'Catalog',
        remediation: 'Publish a mapping version before enabling inbound ARI.',
        correlationId,
      });
    }

    const cctx = this.contextFor(conn, correlationId, mapping.version);
    let events;
    try {
      events = adapter.parsePush(args.payload, cctx, this.mapping.toResolver(mapping, conn.tenantId));
    } catch (err) {
      await this.prisma.rawEnvelope.update({
        where: { id: envelope.id },
        data: { outcome: 'REJECTED', rejectReason: String(err).slice(0, 500) },
      });
      throw err;
    }

    await this.prisma.rawEnvelope.update({
      where: { id: envelope.id },
      data: { eventCount: events.length },
    });

    await this.bus.publish(
      'RawARIReceived',
      {
        connectionId: conn.id,
        envelopeId: envelope.id,
        propertyId: conn.propertyId,
        eventCount: events.length,
        payloadHash,
      },
      { tenantId: conn.tenantId, partitionKey: conn.propertyId, correlationId },
    );

    // Hand off to ari-ingestion. A synchronous call keeps the ACK honest: we
    // only tell the provider "accepted" once the ledger has the events.
    const svcCtx: RequestContext = systemContext({
      tenantId: conn.tenantId,
      actor: `connector:${conn.id}`,
      correlationId,
    });
    const result = await clients.ari.post<any>('/internal/ari/events', svcCtx, {
      events,
      rawEnvelopeId: envelope.id,
    });

    await this.prisma.connection.update({
      where: { id: conn.id },
      data: { lastEventAt: new Date(), status: conn.status === 'PENDING' ? 'ACTIVE' : conn.status },
    });

    metrics.inc(M.ariReceived, { provider: conn.provider }, events.length);
    return { envelopeId: envelope.id, correlationId, parsed: events.length, ingest: result };
  }

  // ── Pull ─────────────────────────────────────────────────

  /**
   * Scheduled sync. The checkpoint advances only after ari-ingestion has
   * durably accepted the batch — advancing it first is exactly how a backfill
   * silently skips a window.
   */
  async pull(
    ctx: RequestContext,
    connectionId: string,
    window?: { from: string; to: string },
  ) {
    const conn = await this.require(ctx, connectionId);
    const adapter = this.registry.get(conn.provider as Provider);
    this.registry.assertCapability(conn.provider as Provider, 'fetchAriPull');

    const mapping = await this.mapping.activeMapping(conn.id);
    if (!mapping) {
      throw new DomainError({
        code: 'INCOMPLETE_MAPPING',
        message: 'Connection has no active mapping version',
        owner: 'Catalog',
        remediation: 'Publish a mapping version before pulling ARI.',
      });
    }

    const from = window?.from ?? toStayDate(new Date());
    const to = window?.to ?? addDays(from, 90);
    const cctx = this.contextFor(conn, ctx.correlationId, mapping.version);
    const pullWindow: PullWindow = {
      from,
      to,
      cursor: (conn.checkpoint as any)?.cursor ?? null,
    };

    const result = await this.runtime.execute(cctx, adapter.rateLimit, 'fetchAri', () =>
      adapter.fetchAri(cctx, pullWindow, this.mapping.toResolver(mapping, conn.tenantId)),
    );

    // Chunked on purpose: one enormous request is a single point of failure
    // and hides which slice of a backfill actually failed.
    const CHUNK = Number(process.env.ARI_INGEST_CHUNK ?? 500);
    const ingest = { accepted: 0, duplicates: 0, outOfOrder: 0, rejected: 0, cellsTouched: 0 };
    for (let i = 0; i < result.events.length; i += CHUNK) {
      const batch = result.events.slice(i, i + CHUNK);
      const res = await clients.ari.post<any>('/internal/ari/events', ctx, { events: batch }, 120_000);
      ingest.accepted += res.accepted ?? 0;
      ingest.duplicates += res.duplicates ?? 0;
      ingest.outOfOrder += res.outOfOrder ?? 0;
      ingest.rejected += res.rejected ?? 0;
      ingest.cellsTouched += res.cellsTouched ?? 0;
    }

    await this.prisma.connection.update({
      where: { id: conn.id },
      data: {
        checkpoint: { cursor: result.nextCursor, window: { from, to }, at: new Date().toISOString() } as any,
        lastEventAt: new Date(),
        status: 'ACTIVE',
      },
    });

    this.log.info('pull complete', {
      connectionId,
      correlationId: ctx.correlationId,
      fetched: result.events.length,
      ...ingest,
    });
    return { fetched: result.events.length, window: { from, to }, ingest };
  }

  // ── Outbound push to the provider ────────────────────────

  async pushToProvider(ctx: RequestContext, connectionId: string, commands: any[]) {
    const conn = await this.require(ctx, connectionId);
    const adapter = this.registry.get(conn.provider as Provider);
    this.registry.assertCapability(conn.provider as Provider, 'pushRate');
    const cctx = this.contextFor(conn, ctx.correlationId);
    return this.runtime.execute(cctx, adapter.rateLimit, 'pushAri', () =>
      adapter.pushAri(cctx, commands),
    );
  }

  // ── Supplier booking ─────────────────────────────────────

  /**
   * Booking against the provider. The idempotency key travels through to the
   * supplier so THEIR retry logic and ours agree on what is the same request.
   *
   * Errors are not swallowed: an unreachable supplier surfaces as a thrown
   * DomainError and the booking saga records UNKNOWN. Returning REJECTED here
   * would be a lie the saga cannot detect.
   */
  async createSupplierBooking(
    ctx: RequestContext,
    connectionId: string,
    cmd: {
      bookingReference: string;
      idempotencyKey: string;
      roomTypeId: string;
      ratePlanId: string;
      checkIn: string;
      checkOut: string;
      adults: number;
      children: number;
      guestName: string;
      amount: number;
      currency: string;
    },
  ) {
    const conn = await this.require(ctx, connectionId);
    const adapter = this.registry.get(conn.provider as Provider);
    this.registry.assertCapability(conn.provider as Provider, 'createBooking');

    const mapping = await this.mapping.activeMapping(conn.id);
    if (!mapping) {
      throw new DomainError({
        code: 'INCOMPLETE_MAPPING',
        message: 'Cannot book through a connection with no active mapping',
        owner: 'Catalog',
      });
    }

    const roomRemoteCode = reverseLookup(mapping.roomTypes, cmd.roomTypeId);
    const ratePlanRemoteCode = reverseLookup(mapping.ratePlans, cmd.ratePlanId);
    if (!roomRemoteCode || !ratePlanRemoteCode) {
      throw new DomainError({
        code: 'INCOMPLETE_MAPPING',
        message: 'Room or rate plan has no remote code in the active mapping',
        owner: 'Catalog',
        details: { roomTypeId: cmd.roomTypeId, ratePlanId: cmd.ratePlanId, mappingVersion: mapping.version },
      });
    }

    const cctx = this.contextFor(conn, ctx.correlationId, mapping.version);
    return this.runtime.execute(cctx, adapter.rateLimit, 'createBooking', () =>
      adapter.createBooking(cctx, {
        bookingReference: cmd.bookingReference,
        idempotencyKey: cmd.idempotencyKey,
        roomRemoteCode,
        ratePlanRemoteCode,
        checkIn: cmd.checkIn,
        checkOut: cmd.checkOut,
        adults: cmd.adults,
        children: cmd.children,
        guestName: cmd.guestName,
        amount: cmd.amount,
        currency: cmd.currency,
      }),
    );
  }

  async cancelSupplierBooking(
    ctx: RequestContext,
    connectionId: string,
    supplierReference: string,
    idempotencyKey: string,
  ) {
    const conn = await this.require(ctx, connectionId);
    const adapter = this.registry.get(conn.provider as Provider);
    this.registry.assertCapability(conn.provider as Provider, 'cancelBooking');
    const cctx = this.contextFor(conn, ctx.correlationId);
    return this.runtime.execute(cctx, adapter.rateLimit, 'cancelBooking', () =>
      adapter.cancelBooking(cctx, supplierReference, idempotencyKey),
    );
  }

  // ── Health ───────────────────────────────────────────────

  async health(ctx: RequestContext, propertyId?: string): Promise<ConnectionHealthSnapshot[]> {
    const conns = await this.list(ctx, propertyId);
    const since = new Date(Date.now() - 86_400_000);

    return Promise.all(
      conns.map(async (conn) => {
        const [events, mappingVersion] = await Promise.all([
          this.prisma.ariEvent.groupBy({
            by: ['status'],
            where: { propertyId: conn.propertyId, receivedAt: { gte: since } },
            _count: true,
          }),
          this.prisma.mappingVersion.findFirst({
            where: { connectionId: conn.id, status: 'ACTIVE' },
            orderBy: { version: 'desc' },
          }),
        ]);

        const count = (s: string) => events.find((e) => e.status === s)?._count ?? 0;
        const issues: string[] = [];
        const adapter = this.registry.has(conn.provider as Provider)
          ? this.registry.get(conn.provider as Provider)
          : null;

        if (!mappingVersion) issues.push('No active mapping version.');
        if (!conn.lastEventAt) issues.push('No ARI event has ever been received.');
        else {
          const ageH = Math.round((Date.now() - conn.lastEventAt.getTime()) / 3_600_000);
          const slaH = Math.round(Number(process.env.ARI_FRESHNESS_SLA_SECONDS ?? 3600) / 3600);
          if (ageH > slaH) issues.push(`Last event ${ageH}h ago, beyond the ${slaH}h SLA.`);
        }
        if (count('REJECTED') > 0) issues.push(`${count('REJECTED')} rejected event(s) in 24h.`);
        if (count('OUT_OF_ORDER') > 0)
          issues.push(`${count('OUT_OF_ORDER')} out-of-order event(s) in 24h.`);
        if (adapter && !adapter.capabilities.receiveAriPush && !adapter.capabilities.fetchAriPull)
          issues.push('Provider adapter is registered but not certified for any ARI transport.');

        return {
          connectionId: conn.id,
          propertyId: conn.propertyId,
          propertyName: (conn as any).property?.name ?? conn.propertyId,
          provider: conn.provider as Provider,
          status: conn.status,
          mode: conn.mode,
          lastEventAt: conn.lastEventAt?.toISOString() ?? null,
          lastHealthAt: conn.lastHealthAt?.toISOString() ?? null,
          lastHealthOk: conn.lastHealthOk,
          eventsLast24h: count('ACCEPTED'),
          rejectedLast24h: count('REJECTED'),
          duplicatesLast24h: count('DUPLICATE'),
          outOfOrderLast24h: count('OUT_OF_ORDER'),
          p95IngestLatencyMs: metrics.snapshot().histograms[M.ariIngestLatency]?.p95 ?? null,
          circuitState: this.runtime.circuitState(conn.id),
          mappingVersion: mappingVersion?.version ?? null,
          mappingStatus: mappingVersion?.status ?? null,
          issues,
        };
      }),
    );
  }

  async runHealthCheck(ctx: RequestContext, connectionId: string) {
    const conn = await this.require(ctx, connectionId);
    const adapter = this.registry.get(conn.provider as Provider);
    const cctx = this.contextFor(conn, ctx.correlationId);
    const result = await adapter.healthCheck(cctx).catch((err) => ({
      ok: false,
      latencyMs: 0,
      detail: String(err),
      capabilities: adapter.capabilities,
    }));

    await this.prisma.connection.update({
      where: { id: conn.id },
      data: {
        lastHealthAt: new Date(),
        lastHealthOk: result.ok,
        lastHealthDetail: result.detail.slice(0, 500),
      },
    });
    await this.audit.record({
      tenantId: ctx.tenantId,
      actorType: 'USER',
      actorId: ctx.userId,
      action: 'connection.health_check',
      resourceType: 'Connection',
      resourceId: conn.id,
      after: { ok: result.ok, detail: result.detail },
      correlationId: ctx.correlationId,
    });
    return result;
  }
}

/** local id -> remote code, from the active mapping. */
function reverseLookup(map: Record<string, string>, localId: string): string | null {
  for (const [remote, local] of Object.entries(map)) {
    if (local === localId) return remote;
  }
  return null;
}
