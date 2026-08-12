import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { EventBus } from '@wetriip/bus';
import { PartitionedDispatcher } from '@wetriip/bus';
import {
  AriIngestResult,
  AriValues,
  NormalizedAriEvent,
  NormalizedAriEventSchema,
  ariIdempotencyKey,
  canonicalAriValues,
  ariPartitionKey,
  sha256,
  toStayDate,
} from '@wetriip/contracts';
import { decideOrder, mergeLayerValues, sortForApplication } from '@wetriip/domain';
import { toNumber } from '@wetriip/persistence';
import { Logger, M, metrics } from '@wetriip/observability';
import { EVENT_BUS, LOGGER, PRISMA, RequestContext } from '@wetriip/service-kit';
import { EffectiveAriService } from './effective.service';

/**
 * ARI ingestion pipeline.
 *
 * The order of operations is the whole design:
 *
 *   1. validate against the canonical schema
 *   2. sort the batch so a payload cannot apply its own updates backwards
 *   3. per cell, decide APPLY / DUPLICATE / OUT_OF_ORDER against current state
 *   4. append ONE ledger row with that decision already recorded
 *   5. only on APPLY, move the layer's cell state
 *   6. recompute Effective ARI for the touched keys
 *   7. publish EffectiveARIChanged
 *
 * Step 3 before step 4 is deliberate: the ledger row is written once, with its
 * outcome, and never updated. A ledger you edit afterwards is a log, not a
 * ledger.
 *
 * Rejected and out-of-order events are still WRITTEN. Evidence of what a
 * partner sent is exactly what you need at 2am, and dropping it is how
 * "the channel manager swears they sent it" becomes unanswerable.
 */
@Injectable()
export class IngestionService {
  private readonly dispatcher = new PartitionedDispatcher();

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(LOGGER) private readonly log: Logger,
    private readonly effective: EffectiveAriService,
  ) {}

  async ingest(
    ctx: RequestContext,
    rawEvents: unknown[],
    opts: { rawEnvelopeId?: string | null } = {},
  ): Promise<AriIngestResult> {
    const started = Date.now();
    const result: AriIngestResult = {
      accepted: 0,
      duplicates: 0,
      outOfOrder: 0,
      rejected: 0,
      cellsTouched: 0,
      rejections: [],
      correlationId: ctx.correlationId,
    };

    // ── 1. Validation ──────────────────────────────────────
    const valid: NormalizedAriEvent[] = [];
    rawEvents.forEach((raw, index) => {
      const parsed = NormalizedAriEventSchema.safeParse(raw);
      if (!parsed.success) {
        result.rejected += 1;
        result.rejections.push({
          index,
          reason: 'SCHEMA',
          detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        });
        metrics.inc(M.ariRejected, { reason: 'schema' });
        return;
      }
      if (parsed.data.tenantId !== ctx.tenantId) {
        // Cross-tenant writes are refused, not filtered. A connector that
        // produces another tenant's id is misconfigured and must be told.
        result.rejected += 1;
        result.rejections.push({ index, reason: 'TENANT_MISMATCH' });
        metrics.inc(M.ariRejected, { reason: 'tenant' });
        return;
      }
      valid.push(parsed.data);
    });

    metrics.inc(M.ariReceived, {}, rawEvents.length);

    // ── 2. Ordered application, partitioned by property/room/rate ──
    const touched = new Map<
      string,
      {
        propertyId: string;
        roomTypeId: string;
        ratePlanId: string;
        stayDates: Set<string>;
        occupancies: Set<number>;
        /** False when the batch only confirmed the values we already held. */
        changed: boolean;
      }
    >();
    const byPartition = new Map<string, NormalizedAriEvent[]>();
    for (const e of sortForApplication(valid)) {
      const k = ariPartitionKey({
        propertyId: e.propertyId,
        roomTypeId: e.roomTypeId,
        ratePlanId: e.ratePlanId,
      });
      byPartition.set(k, [...(byPartition.get(k) ?? []), e]);
    }

    await Promise.all(
      [...byPartition.entries()].map(([partition, events]) =>
        this.dispatcher.submit(partition, async () => {
          for (const e of events) {
            const outcome = await this.applyOne(e, opts.rawEnvelopeId ?? null);
            // A DUPLICATE still counts as PROOF OF LIFE. A channel manager
            // republishing identical inventory every five minutes is actively
            // confirming the data is current — treating that as stale would
            // report a healthy feed as dead, which is the opposite of what
            // freshness exists to tell us.
            if (outcome === 'ACCEPTED' || outcome === 'DUPLICATE') {
              const key = `${e.propertyId}|${e.roomTypeId}|${e.ratePlanId}`;
              const entry =
                touched.get(key) ??
                {
                  propertyId: e.propertyId,
                  roomTypeId: e.roomTypeId,
                  ratePlanId: e.ratePlanId,
                  stayDates: new Set<string>(),
                  occupancies: new Set<number>(),
                  changed: false,
                };
              entry.stayDates.add(e.stayDate);
              entry.occupancies.add(e.occupancy);
              if (outcome === 'ACCEPTED') entry.changed = true;
              touched.set(key, entry);
            }

            if (outcome === 'ACCEPTED') {
              result.accepted += 1;
              metrics.inc(M.ariAccepted, { source: e.source });
            } else if (outcome === 'DUPLICATE') {
              result.duplicates += 1;
              metrics.inc(M.ariDuplicate, { source: e.source });
            } else if (outcome === 'OUT_OF_ORDER') {
              result.outOfOrder += 1;
              metrics.inc(M.ariOutOfOrder, { source: e.source });
            }
          }
        }),
      ),
    );

    // ── 3. Materialize Effective ARI for touched keys ──────
    for (const entry of touched.values()) {
      for (const occupancy of entry.occupancies) {
        const dates = [...entry.stayDates];
        await this.effective.recompute(ctx.tenantId, {
          propertyId: entry.propertyId,
          roomTypeId: entry.roomTypeId,
          ratePlanId: entry.ratePlanId,
          stayDates: dates,
          occupancy,
        });
        result.cellsTouched += dates.length;
      }

      // Recomputation happens either way so freshness moves, but only a real
      // change is announced. Publishing on every heartbeat would wake every
      // downstream consumer for nothing.
      if (entry.changed) {
        await this.bus.publish(
          'EffectiveARIChanged',
          {
            propertyId: entry.propertyId,
            roomTypeId: entry.roomTypeId,
            ratePlanId: entry.ratePlanId,
            stayDates: [...entry.stayDates],
            reason: 'INGEST',
          },
          {
            tenantId: ctx.tenantId,
            partitionKey: ariPartitionKey(entry),
            correlationId: ctx.correlationId,
          },
        );
      }
    }

    metrics.observe(M.ariIngestLatency, Date.now() - started);
    this.log.info('ari ingest complete', {
      ...result,
      correlationId: ctx.correlationId,
      latencyMs: Date.now() - started,
    });
    return result;
  }

  /**
   * One event, one ledger row, one decision. Runs inside a transaction so the
   * ledger row and the cell state can never disagree.
   */
  private async applyOne(
    e: NormalizedAriEvent,
    rawEnvelopeId: string | null,
  ): Promise<'ACCEPTED' | 'DUPLICATE' | 'OUT_OF_ORDER' | 'REJECTED'> {
    const payloadHash = sha256(e.values);
    const idempotencyKey = ariIdempotencyKey({
      source: e.source,
      key: {
        tenantId: e.tenantId,
        propertyId: e.propertyId,
        roomTypeId: e.roomTypeId,
        ratePlanId: e.ratePlanId,
        stayDate: e.stayDate,
        occupancy: e.occupancy,
      },
      layer: e.layer,
      sourceTimestamp: e.sourceTimestamp,
      payloadHash,
    });

    const cellWhere = {
      tenantId_propertyId_roomTypeId_ratePlanId_stayDate_occupancy_layer: {
        tenantId: e.tenantId,
        propertyId: e.propertyId,
        roomTypeId: e.roomTypeId,
        ratePlanId: e.ratePlanId,
        stayDate: new Date(`${e.stayDate}T00:00:00.000Z`),
        occupancy: e.occupancy,
        layer: e.layer,
      },
    };

    try {
      return await this.prisma.$transaction(async (tx) => {
        const current = await tx.ariCell.findUnique({ where: cellWhere as any });
        const before = current ? cellToValues(current) : null;

        // The state this event WOULD produce. Hashing the result rather than
        // the incoming payload is what makes a republished full snapshot a
        // no-op: channel managers resend unchanged inventory constantly, and
        // each resend must not bump a version or emit a change event.
        const after = mergeLayerValues(before ?? {}, e.values);
        const resultingHash = sha256(canonicalAriValues(after));

        const decision = decideOrder(
          {
            sourceTimestamp: e.sourceTimestamp,
            sourceSequence: e.sourceSequence == null ? null : BigInt(e.sourceSequence as any),
            payloadHash: resultingHash,
          },
          current
            ? {
                sourceTimestamp: current.sourceTimestamp,
                sourceSequence: current.sourceSequence,
                lastPayloadHash: current.lastPayloadHash,
              }
            : null,
        );

        await tx.ariEvent.create({
          data: {
            tenantId: e.tenantId,
            propertyId: e.propertyId,
            roomTypeId: e.roomTypeId,
            ratePlanId: e.ratePlanId,
            stayDate: new Date(`${e.stayDate}T00:00:00.000Z`),
            occupancy: e.occupancy,
            layer: e.layer,
            eventType: e.eventType,
            source: e.source,
            sourceSequence: e.sourceSequence == null ? null : BigInt(e.sourceSequence as any),
            before: (before ?? undefined) as any,
            after: e.values as any,
            sourceTimestamp: e.sourceTimestamp,
            processedAt: new Date(),
            payloadHash,
            idempotencyKey,
            correlationId: e.correlationId,
            mappingVersion: e.mappingVersion ?? null,
            rawEnvelopeId,
            actorType: e.actorType,
            actorId: e.actorId ?? null,
            reason: e.reason ?? null,
            status:
              decision.decision === 'APPLY'
                ? 'ACCEPTED'
                : decision.decision === 'DUPLICATE'
                  ? 'DUPLICATE'
                  : 'OUT_OF_ORDER',
            rejectReason: decision.decision === 'APPLY' ? null : decision.reason,
          },
        });

        if (decision.decision === 'DUPLICATE' && current) {
          // Value untouched, version untouched, no change event. Only the
          // evidence that the source is still talking to us.
          await tx.ariCell.update({
            where: cellWhere as any,
            data: {
              receivedAt: new Date(),
              sourceTimestamp:
                e.sourceTimestamp > current.sourceTimestamp
                  ? e.sourceTimestamp
                  : current.sourceTimestamp,
            },
          });
          return 'DUPLICATE';
        }

        if (decision.decision !== 'APPLY') {
          return decision.decision;
        }

        await tx.ariCell.upsert({
          where: cellWhere as any,
          create: {
            tenantId: e.tenantId,
            propertyId: e.propertyId,
            roomTypeId: e.roomTypeId,
            ratePlanId: e.ratePlanId,
            stayDate: new Date(`${e.stayDate}T00:00:00.000Z`),
            occupancy: e.occupancy,
            layer: e.layer,
            ...valuesToCell(after),
            validFrom: e.validFrom ?? null,
            validTo: e.validTo ?? null,
            reason: e.reason ?? null,
            approvedBy: e.actorType === 'AGENT' || e.actorType === 'USER' ? e.actorId : null,
            version: 1,
            source: e.source,
            sourceTimestamp: e.sourceTimestamp,
            sourceSequence: e.sourceSequence == null ? null : BigInt(e.sourceSequence as any),
            lastPayloadHash: resultingHash,
            mappingVersion: e.mappingVersion ?? null,
          },
          update: {
            ...valuesToCell(after),
            ...(e.validFrom !== undefined ? { validFrom: e.validFrom ?? null } : {}),
            ...(e.validTo !== undefined ? { validTo: e.validTo ?? null } : {}),
            ...(e.reason ? { reason: e.reason } : {}),
            version: { increment: 1 },
            source: e.source,
            sourceTimestamp: e.sourceTimestamp,
            sourceSequence: e.sourceSequence == null ? null : BigInt(e.sourceSequence as any),
            lastPayloadHash: resultingHash,
            receivedAt: new Date(),
            mappingVersion: e.mappingVersion ?? null,
          },
        });

        return 'ACCEPTED';
      });
    } catch (err: any) {
      // Unique violation on idempotencyKey: the transport redelivered an event
      // we have already durably recorded. Exactly the case we designed for.
      if (err?.code === 'P2002') return 'DUPLICATE';
      this.log.error('ari apply failed', {
        correlationId: e.correlationId,
        propertyId: e.propertyId,
        stayDate: e.stayDate,
        error: String(err),
      });
      return 'REJECTED';
    }
  }

  /**
   * Managed-layer override. Same ledger, same ordering rules, different layer —
   * a human or agent decision never rewrites what the supplier sent.
   */
  async applyManagedOverride(
    ctx: RequestContext,
    input: {
      propertyId: string;
      roomTypeId: string;
      ratePlanId: string;
      stayDates: string[];
      occupancy?: number;
      values: AriValues;
      reason: string;
      validFrom?: string | null;
      validTo?: string | null;
      actorType?: 'USER' | 'AGENT';
    },
  ): Promise<AriIngestResult> {
    const now = new Date();
    const events: NormalizedAriEvent[] = input.stayDates.map((stayDate) => ({
      tenantId: ctx.tenantId,
      propertyId: input.propertyId,
      roomTypeId: input.roomTypeId,
      ratePlanId: input.ratePlanId,
      stayDate: toStayDate(stayDate),
      occupancy: input.occupancy ?? 2,
      layer: 'MANAGED',
      eventType: input.values.baseAmount != null ? 'RATE_UPDATED' : input.values.available != null ? 'AVAILABILITY_UPDATED' : 'RESTRICTION_UPDATED',
      source: `${input.actorType ?? 'USER'}:${ctx.userId}`,
      sourceSequence: null,
      sourceTimestamp: now,
      values: input.values,
      mappingVersion: null,
      correlationId: ctx.correlationId,
      rawEnvelopeId: null,
      actorType: input.actorType ?? 'USER',
      actorId: ctx.userId,
      reason: input.reason,
      validFrom: input.validFrom ? new Date(input.validFrom) : null,
      validTo: input.validTo ? new Date(input.validTo) : null,
    }));

    return this.ingest(ctx, events);
  }
}

function cellToValues(cell: any): AriValues {
  return {
    allotment: cell.allotment,
    available: cell.available,
    sold: cell.sold,
    overbookingLimit: cell.overbookingLimit,
    currency: cell.currency,
    baseAmount: toNumber(cell.baseAmount),
    adultPrices: cell.adultPrices,
    childPrices: cell.childPrices,
    open: cell.open,
    stopSell: cell.stopSell,
    closedToArrival: cell.closedToArrival,
    closedToDeparture: cell.closedToDeparture,
    minLos: cell.minLos,
    maxLos: cell.maxLos,
    releaseDays: cell.releaseDays,
    bookingGap: cell.bookingGap,
  };
}

function valuesToCell(v: AriValues) {
  return {
    allotment: v.allotment ?? null,
    available: v.available ?? null,
    sold: v.sold ?? null,
    overbookingLimit: v.overbookingLimit ?? null,
    currency: v.currency ?? null,
    baseAmount: v.baseAmount ?? null,
    adultPrices: (v.adultPrices ?? null) as any,
    childPrices: (v.childPrices ?? null) as any,
    open: v.open ?? null,
    stopSell: v.stopSell ?? null,
    closedToArrival: v.closedToArrival ?? null,
    closedToDeparture: v.closedToDeparture ?? null,
    minLos: v.minLos ?? null,
    maxLos: v.maxLos ?? null,
    releaseDays: v.releaseDays ?? null,
    bookingGap: v.bookingGap ?? null,
  };
}
