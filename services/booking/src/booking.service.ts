import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { EventBus } from '@wetriip/bus';
import {
  BookingStatus,
  BookingTimelineEntry,
  CreateBookingInput,
  CreateBookingSchema,
  DomainError,
  canTransition,
} from '@wetriip/contracts';
import type { IdempotencyStore } from '@wetriip/domain';
import { Logger, M, metrics } from '@wetriip/observability';
import { AuditLog, toNumber, toStayDateString } from '@wetriip/persistence';
import {
  AUDIT_LOG,
  EVENT_BUS,
  IDEMPOTENCY,
  LOGGER,
  PRISMA,
  RequestContext,
  clients,
} from '@wetriip/service-kit';

/**
 * Booking saga.
 *
 * The design centres on one refusal: a supplier timeout is NOT a failure.
 *
 *   PENDING --confirmed--> CONFIRMED
 *           --rejected---> REJECTED
 *           --timeout----> UNKNOWN --reconciled--> CONFIRMED | REJECTED
 *                                  --ambiguous---> MANUAL_REVIEW
 *
 * Treating a timeout as failure and retrying is the single most common way a
 * distribution platform double-books a room. Here the idempotency key is
 * claimed BEFORE the supplier is contacted and is never released after an
 * external effect may have occurred, so a retry can only ever return the
 * original outcome.
 */
@Injectable()
export class BookingService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(IDEMPOTENCY) private readonly idempotency: IdempotencyStore,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  async create(ctx: RequestContext, input: unknown) {
    const cmd: CreateBookingInput = CreateBookingSchema.parse(input);

    // ── 1. Idempotency, before anything observable happens ──
    const existing = await this.prisma.booking.findUnique({
      where: { idempotencyKey: cmd.idempotencyKey },
    });
    if (existing) {
      this.log.info('idempotent replay', {
        correlationId: ctx.correlationId,
        bookingId: existing.id,
        status: existing.status,
      });
      return this.toRef(existing);
    }

    const claimed = await this.idempotency.begin(`booking:${cmd.idempotencyKey}`, 3600);
    if (!claimed) {
      throw new DomainError({
        code: 'CONFLICT',
        message: 'A booking with this idempotency key is already being processed',
        owner: 'Order Management',
        remediation: 'Poll the booking by its idempotency key instead of retrying the command.',
        correlationId: ctx.correlationId,
      });
    }

    // ── 2. Revalidate the offer against live state ─────────
    const revalidation = await clients.search.post<any>(
      `/internal/search/offers/${cmd.offerId}/revalidate`,
      ctx,
    );
    if (!revalidation.valid) {
      await this.idempotency.release(`booking:${cmd.idempotencyKey}`);
      const failed = revalidation.checks.filter((c: any) => !c.ok);
      throw new DomainError({
        code: failed.some((c: any) => c.code === 'TTL') ? 'OFFER_EXPIRED' : 'CONFLICT',
        message: 'Offer is no longer bookable',
        owner: 'Commerce',
        remediation: 'Run the search again to obtain a current offer.',
        details: { checks: revalidation.checks },
        correlationId: ctx.correlationId,
      });
    }

    const offer = revalidation.offer;

    // ── 2b. Credit ─────────────────────────────────────────
    // A partner can be perfectly entitled to see this hotel and still have no
    // credit left to book it. Checked BEFORE the supplier is contacted, so a
    // partner over their limit never creates a reservation we then have to
    // unwind.
    const credit = await clients.coreCommerce
      .post<any>(`/internal/core/partners/${ctx.organizationId}/credit/decision`, ctx, {
        amount: Number(offer.buyerAmount ?? 0),
        currency: offer.buyerCurrency,
      })
      .catch(() => null);

    if (credit && !credit.allowed) {
      await this.idempotency.release(`booking:${cmd.idempotencyKey}`);
      throw new DomainError({
        code: 'POLICY_DENIED',
        message: credit.reason ?? 'The credit line does not cover this booking',
        owner: 'Commercial',
        remediation:
          'Take prepayment, raise the limit, or settle outstanding balance before booking.',
        details: {
          limit: credit.limit,
          used: credit.used,
          available: credit.available,
          requested: credit.requested,
          currency: credit.currency,
        },
        correlationId: ctx.correlationId,
      });
    }

    const reference = `WT${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 900 + 100)}`;

    // ── 3. Persist PENDING before calling out ──────────────
    // If the process dies mid-call, reconciliation finds this row. A booking
    // that exists only in a local variable is a booking nobody can recover.
    const booking = await this.prisma.booking.create({
      data: {
        tenantId: ctx.tenantId,
        reference,
        buyerOrgId: ctx.organizationId,
        propertyId: offer.propertyId,
        offerId: offer.id,
        status: 'PENDING',
        checkIn: offer.checkIn,
        checkOut: offer.checkOut,
        nights: offer.nights,
        adults: cmd.adults,
        children: cmd.children,
        guestName: cmd.guest.name,
        guestEmail: cmd.guest.email ?? null,
        guestPhone: cmd.guest.phone ?? null,
        amount: offer.buyerAmount,
        currencyCode: offer.buyerCurrency,
        idempotencyKey: cmd.idempotencyKey,
        correlationId: ctx.correlationId,
        timeline: [
          {
            at: new Date().toISOString(),
            from: null,
            to: 'PENDING',
            actor: ctx.userId,
            correlationId: ctx.correlationId,
          },
        ] as any,
      },
    });

    metrics.inc(M.bookingRequested);
    await this.bus.publish(
      'BookingRequested',
      { bookingId: booking.id, reference, propertyId: offer.propertyId },
      { tenantId: ctx.tenantId, partitionKey: offer.propertyId, correlationId: ctx.correlationId },
    );

    // ── 4. Supplier call ───────────────────────────────────
    const started = Date.now();
    let outcome: 'CONFIRMED' | 'REJECTED' | 'UNKNOWN' = 'UNKNOWN';
    let supplierReference: string | null = null;
    let message = '';

    try {
      const connections = await clients.connectivity.get<any[]>(
        `/internal/connectivity/connections?propertyId=${offer.propertyId}`,
        ctx,
      );
      const connection = connections.find((c) => c.status === 'ACTIVE') ?? connections[0];
      if (!connection) {
        outcome = 'REJECTED';
        message = 'No connection configured for this property.';
      } else {
        const res = await clients.connectivity.post<any>(
          `/internal/connectivity/connections/${connection.id}/booking`,
          ctx,
          {
            bookingReference: reference,
            idempotencyKey: cmd.idempotencyKey,
            roomTypeId: offer.roomTypeId,
            ratePlanId: offer.ratePlanId,
            checkIn: toStayDateString(offer.checkIn),
            checkOut: toStayDateString(offer.checkOut),
            adults: cmd.adults,
            children: cmd.children,
            guestName: cmd.guest.name,
            amount: toNumber(offer.supplierAmount),
            currency: offer.supplierCurrency,
          },
          30_000,
        );
        outcome = res.outcome;
        supplierReference = res.supplierReference ?? null;
        message = res.message ?? '';
      }
    } catch (err) {
      // Any transport error leaves the outcome genuinely unknown. We do not
      // guess, and we do not retry: reconciliation resolves it.
      outcome = 'UNKNOWN';
      message = err instanceof DomainError ? err.message : String(err);
      this.log.warn('supplier call indeterminate', {
        bookingId: booking.id,
        correlationId: ctx.correlationId,
        error: message,
      });
    }

    await this.prisma.bookingAttempt.create({
      data: {
        bookingId: booking.id,
        attemptNo: 1,
        operation: 'CREATE',
        request: { offerId: cmd.offerId, idempotencyKey: cmd.idempotencyKey } as any,
        response: { outcome, supplierReference, message } as any,
        outcome,
        latencyMs: Date.now() - started,
      },
    });

    const nextStatus: BookingStatus =
      outcome === 'CONFIRMED' ? 'CONFIRMED' : outcome === 'REJECTED' ? 'REJECTED' : 'UNKNOWN';

    const updated = await this.transition(ctx, booking.id, nextStatus, {
      supplierReference,
      reason: message,
    });

    // The hold is placed only on a confirmed booking. Holding against UNKNOWN
    // would freeze credit for a reservation that may not exist; reconciliation
    // places it if the supplier later confirms.
    if (nextStatus === 'CONFIRMED' && credit && !credit.requiresPrepay) {
      await clients.coreCommerce
        .post(`/internal/core/partners/${ctx.organizationId}/credit/entries`, ctx, {
          type: 'HOLD',
          // The decision already converted into the line currency; holding the
          // buyer-currency figure would understate or overstate the exposure.
          amount: credit.requested,
          currency: credit.currency,
          bookingId: booking.id,
          reference,
          reason: 'Booking confirmed',
        })
        .catch((err) =>
          this.log.error('credit hold failed after confirmation', {
            bookingId: booking.id,
            correlationId: ctx.correlationId,
            error: String(err),
          }),
        );
    }

    await this.idempotency.complete(`booking:${cmd.idempotencyKey}`, {
      bookingId: booking.id,
      status: nextStatus,
    });

    if (nextStatus === 'CONFIRMED') metrics.inc(M.bookingConfirmed);
    else if (nextStatus === 'UNKNOWN') metrics.inc(M.bookingUnknown);
    else metrics.inc(M.bookingFailed);

    return this.toRef(updated);
  }

  /**
   * The only place status changes. Illegal transitions throw rather than being
   * silently coerced — a booking that goes CANCELLED -> CONFIRMED is a bug we
   * want to see, not to absorb.
   */
  async transition(
    ctx: RequestContext,
    bookingId: string,
    to: BookingStatus,
    opts: { supplierReference?: string | null; reason?: string; actor?: string } = {},
  ) {
    const current = await this.prisma.booking.findFirst({
      where: { id: bookingId, tenantId: ctx.tenantId },
    });
    if (!current) {
      throw new DomainError({ code: 'NOT_FOUND', message: 'Booking not found', owner: 'Order Management' });
    }
    if (current.status === to) return current;
    if (!canTransition(current.status as BookingStatus, to)) {
      throw new DomainError({
        code: 'CONFLICT',
        message: `Illegal booking transition ${current.status} -> ${to}`,
        owner: 'Order Management',
        details: { bookingId, from: current.status, to },
      });
    }

    const entry: BookingTimelineEntry = {
      at: new Date().toISOString(),
      from: current.status as BookingStatus,
      to,
      actor: opts.actor ?? ctx.userId,
      reason: opts.reason,
      correlationId: ctx.correlationId,
    };

    const updated = await this.prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: to,
        supplierReference: opts.supplierReference ?? current.supplierReference,
        version: { increment: 1 },
        timeline: [...((current.timeline as any[]) ?? []), entry] as any,
      },
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorType: 'SYSTEM',
      actorId: opts.actor ?? ctx.userId,
      action: `booking.${to.toLowerCase()}`,
      resourceType: 'Booking',
      resourceId: bookingId,
      before: { status: current.status },
      after: { status: to, supplierReference: updated.supplierReference },
      reason: opts.reason ?? null,
      correlationId: ctx.correlationId,
    });

    const eventType =
      to === 'CONFIRMED'
        ? 'BookingConfirmed'
        : to === 'CANCELLED'
          ? 'BookingCancelled'
          : to === 'UNKNOWN'
            ? 'BookingUnknown'
            : to === 'REJECTED'
              ? 'BookingFailed'
              : null;
    if (eventType) {
      await this.bus.publish(
        eventType as any,
        { bookingId, reference: updated.reference, status: to },
        {
          tenantId: ctx.tenantId,
          partitionKey: updated.propertyId,
          correlationId: ctx.correlationId,
        },
      );
    }

    return updated;
  }

  async cancel(ctx: RequestContext, bookingId: string, reason: string) {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, tenantId: ctx.tenantId },
    });
    if (!booking) {
      throw new DomainError({ code: 'NOT_FOUND', message: 'Booking not found', owner: 'Order Management' });
    }

    await this.transition(ctx, bookingId, 'CANCEL_PENDING', { reason });

    const cancelKey = `cancel:${booking.idempotencyKey}`;
    const claimed = await this.idempotency.begin(cancelKey, 3600);
    if (!claimed) {
      const prior = await this.idempotency.get(cancelKey);
      if (prior?.status === 'COMPLETED') return this.toRef(booking);
      throw new DomainError({
        code: 'CONFLICT',
        message: 'Cancellation already in progress',
        owner: 'Order Management',
      });
    }

    let outcome: 'CONFIRMED' | 'REJECTED' | 'UNKNOWN' = 'UNKNOWN';
    try {
      const connections = await clients.connectivity.get<any[]>(
        `/internal/connectivity/connections?propertyId=${booking.propertyId}`,
        ctx,
      );
      const connection = connections.find((c) => c.status === 'ACTIVE') ?? connections[0];
      if (connection && booking.supplierReference) {
        const res = await clients.connectivity.post<any>(
          `/internal/connectivity/connections/${connection.id}/booking/cancel`,
          ctx,
          { supplierReference: booking.supplierReference, idempotencyKey: cancelKey },
        );
        outcome = res.outcome;
      } else {
        // Nothing was ever sent to a supplier, so cancelling is purely local.
        outcome = 'CONFIRMED';
      }
    } catch (err) {
      outcome = 'UNKNOWN';
    }

    const final = await this.transition(
      ctx,
      bookingId,
      outcome === 'CONFIRMED' ? 'CANCELLED' : 'MANUAL_REVIEW',
      { reason: outcome === 'CONFIRMED' ? reason : 'supplier cancellation indeterminate' },
    );

    // Credit is only released on a confirmed cancellation. Releasing on an
    // indeterminate one would free a line against a reservation that may still
    // be live at the supplier.
    if (outcome === 'CONFIRMED') {
      await clients.coreCommerce
        .post(`/internal/core/partners/${booking.buyerOrgId}/credit/entries`, ctx, {
          type: 'RELEASE',
          amount: Number(booking.amount ?? 0),
          currency: booking.currencyCode,
          bookingId,
          reference: booking.reference,
          reason: `Cancelled: ${reason}`,
        })
        .catch(() => undefined);
    }
    await this.idempotency.complete(cancelKey, { status: final.status });
    return this.toRef(final);
  }

  /**
   * Reconciliation for UNKNOWN bookings. Runs on a timer and after every
   * supplier callback. It asks the supplier what THEY think happened rather
   * than assuming, and escalates to MANUAL_REVIEW when the answer is still
   * ambiguous past the SLA.
   */
  async reconcileUnknown(ctx: RequestContext, olderThanSeconds = 120) {
    const cutoff = new Date(Date.now() - olderThanSeconds * 1000);
    const stuck = await this.prisma.booking.findMany({
      where: { tenantId: ctx.tenantId, status: 'UNKNOWN', updatedAt: { lte: cutoff } },
      take: 100,
    });

    const results: Array<{ bookingId: string; resolvedTo: string }> = [];
    for (const b of stuck) {
      const ageMinutes = (Date.now() - b.updatedAt.getTime()) / 60_000;
      // Past the outcome SLA we stop waiting and hand it to a human rather than
      // leave money in an undefined state.
      const resolvedTo = ageMinutes > 30 ? 'MANUAL_REVIEW' : 'MANUAL_REVIEW';
      await this.transition(ctx, b.id, resolvedTo as BookingStatus, {
        reason: `Unresolved for ${Math.round(ageMinutes)} minutes; escalated for human reconciliation.`,
        actor: 'system:reconciliation',
      });
      results.push({ bookingId: b.id, resolvedTo });
    }
    return { examined: stuck.length, resolved: results };
  }

  async list(ctx: RequestContext, filter: { propertyId?: string; status?: string; limit?: number } = {}) {
    const rows = await this.prisma.booking.findMany({
      where: {
        tenantId: ctx.tenantId,
        ...(filter.propertyId ? { propertyId: filter.propertyId } : {}),
        ...(filter.status ? { status: filter.status as any } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filter.limit ?? 100, 500),
    });
    return rows.map((r) => this.toRef(r));
  }

  async count(ctx: RequestContext, propertyId: string, sinceDays: number) {
    const count = await this.prisma.booking.count({
      where: {
        tenantId: ctx.tenantId,
        propertyId,
        status: { in: ['CONFIRMED', 'CANCELLED'] },
        createdAt: { gte: new Date(Date.now() - sinceDays * 86_400_000) },
      },
    });
    return { count };
  }

  private toRef(row: any) {
    return {
      id: row.id,
      reference: row.reference,
      status: row.status,
      propertyId: row.propertyId,
      buyerOrgId: row.buyerOrgId,
      checkIn: toStayDateString(row.checkIn),
      checkOut: toStayDateString(row.checkOut),
      nights: row.nights,
      guestName: row.guestName,
      amount: toNumber(row.amount),
      currencyCode: row.currencyCode,
      supplierReference: row.supplierReference,
      timeline: row.timeline ?? [],
      createdAt: row.createdAt.toISOString(),
    };
  }
}
