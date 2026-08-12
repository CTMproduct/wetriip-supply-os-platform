import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import {
  BEDDING_LABELS,
  CreateGroupRequestSchema,
  DomainError,
  GroupBenefit,
  GroupRoomRequest,
  RespondGroupRequestSchema,
  nightsBetween,
} from '@wetriip/contracts';
import { assertCan, bidExpiry, canBlockTake, evaluateBid, hoursRemaining } from '@wetriip/domain';
import { AuditLog } from '@wetriip/persistence';
import { AUDIT_LOG, PRISMA, RequestContext } from '@wetriip/service-kit';
import { BlockService } from './block.service';
import { InventoryService } from './inventory.service';
import { NotificationService } from './notification.service';
import { money, toNumber } from './util';

/**
 * The negotiation.
 *
 * An agency arrives with a budget, not a search. Four decisions shape this:
 *
 *  · **Rounds are append-only.** A counter-offer is a new row, never an edit.
 *    Both sides must be able to show what was said and when.
 *  · **The clock belongs to the offer.** The expiry is computed once, from the
 *    hotel's own response window, and stored on the row — so the countdown the
 *    hotel sees and the deadline the sweeper enforces are the same number.
 *  · **A live offer holds inventory.** Otherwise two agencies negotiate over
 *    the same twenty rooms and both are told yes.
 *  · **Nothing here decides.** `evaluateBid` returns a verdict with the
 *    arithmetic; a human accepts. The one automatic path — auto-decline below
 *    floor — is a rule the hotel switched on itself, and it is recorded as
 *    such.
 */
@Injectable()
export class RequestService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    private readonly blocks: BlockService,
    private readonly notifications: NotificationService,
    private readonly inventory: InventoryService,
  ) {}

  private principal(ctx: RequestContext) {
    return {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
      role: ctx.role as any,
      permissions: ctx.permissions,
      propertyIds: ctx.propertyIds,
      status: ctx.status,
    };
  }

  /* ── Reading ───────────────────────────────────────────── */

  async list(
    ctx: RequestContext,
    filter: { propertyId?: string; status?: string; mine?: boolean } = {},
  ) {
    assertCan(this.principal(ctx), 'groups.read');

    // A buyer sees only its own requests. This is scoped by organization rather
    // than by permission: the agency legitimately holds groups.negotiate, and
    // that must never become a window into other agencies' bids.
    const isBuyer = ctx.role === 'AGENCY_ADMIN';
    const rows = await this.prisma.groupRequest.findMany({
      where: {
        tenantId: ctx.tenantId,
        ...(filter.propertyId ? { propertyId: filter.propertyId } : {}),
        ...(filter.status ? { status: filter.status as any } : {}),
        ...(isBuyer || filter.mine ? { organizationId: ctx.organizationId } : {}),
      },
      include: { bids: { orderBy: { round: 'asc' } } },
      orderBy: [{ status: 'asc' }, { expiresAt: 'asc' }],
      take: 200,
    });

    const orgs = await this.prisma.organization.findMany({
      where: { tenantId: ctx.tenantId },
      select: { id: true, name: true, code: true },
    });
    const properties = await this.prisma.property.findMany({
      where: { tenantId: ctx.tenantId },
      select: { id: true, name: true, code: true },
    });

    return rows.map((r) => this.shape(r, orgs, properties));
  }

  async get(ctx: RequestContext, id: string) {
    assertCan(this.principal(ctx), 'groups.read');
    const row = await this.prisma.groupRequest.findFirst({
      where: { id, tenantId: ctx.tenantId },
      include: { bids: { orderBy: { round: 'asc' } }, notifications: true },
    });
    if (!row) {
      throw new DomainError({ code: 'NOT_FOUND', message: 'Group request not found', owner: 'Groups' });
    }
    if (ctx.role === 'AGENCY_ADMIN' && row.organizationId !== ctx.organizationId) {
      throw new DomainError({
        code: 'PERMISSION',
        message: 'This request belongs to another agency.',
        owner: 'Groups',
      });
    }
    const orgs = await this.prisma.organization.findMany({
      where: { tenantId: ctx.tenantId },
      select: { id: true, name: true, code: true },
    });
    const properties = await this.prisma.property.findMany({
      where: { tenantId: ctx.tenantId },
      select: { id: true, name: true, code: true },
    });
    return {
      ...this.shape(row, orgs, properties),
      notifications: row.notifications.map((n) => ({
        channel: n.channel,
        recipient: n.recipient,
        status: n.status,
        requirement: n.requirement,
        createdAt: n.createdAt.toISOString(),
      })),
    };
  }

  private shape(
    r: any,
    orgs: { id: string; name: string; code: string }[],
    properties: { id: string; name: string; code: string }[],
  ) {
    const org = orgs.find((o) => o.id === r.organizationId);
    const property = properties.find((p) => p.id === r.propertyId);
    const rooms = (r.rooms as GroupRoomRequest[]) ?? [];
    const nights = Math.max(1, nightsBetween(r.checkIn, r.checkOut));
    const roomsTotal = rooms.reduce((a, x) => a + x.rooms, 0);

    return {
      id: r.id,
      propertyId: r.propertyId,
      propertyName: property?.name ?? r.propertyId,
      blockId: r.blockId,
      organizationId: r.organizationId,
      // Every notification and every list row names the agency. A hotel decides
      // a group differently depending on who is asking, and hiding it behind an
      // id makes the decision worse.
      agencyName: org?.name ?? r.organizationId,
      agencyCode: org?.code ?? null,
      groupName: r.groupName,
      checkIn: r.checkIn,
      checkOut: r.checkOut,
      nights,
      pax: r.pax,
      rooms,
      roomsTotal,
      roomsSummary: rooms.map((x) => `${x.rooms} ${BEDDING_LABELS[x.bedding]}`).join(', '),
      budgetTotal: toNumber(r.budgetTotal),
      currentTotal: toNumber(r.currentTotal),
      currentActor: r.currentActor,
      currency: r.currency,
      inclusions: r.inclusions,
      notes: r.notes,
      status: r.status,
      expiresAt: r.expiresAt.toISOString(),
      hoursRemaining: Math.round(hoursRemaining(r.expiresAt, new Date()) * 10) / 10,
      settledAt: r.settledAt?.toISOString() ?? null,
      settlement: r.settlement,
      // Whether the committed rooms actually came out of sale. Surfaced on
      // every row because a silent failure here is an oversell.
      inventoryStatus: r.inventoryStatus,
      inventoryDetail: r.inventoryDetail,
      inventoryAppliedAt: r.inventoryAppliedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      rounds: (r.bids ?? []).map((b: any) => ({
        round: b.round,
        actor: b.actor,
        total: toNumber(b.total),
        currency: b.currency,
        benefits: b.benefits,
        message: b.message,
        evaluation: b.evaluation,
        expiresAt: b.expiresAt.toISOString(),
        createdAt: b.createdAt.toISOString(),
      })),
    };
  }

  /* ── The agency raises a request ───────────────────────── */

  async create(ctx: RequestContext, input: unknown) {
    assertCan(this.principal(ctx), 'groups.negotiate');
    const req = CreateGroupRequestSchema.parse(input);

    const property = await this.prisma.property.findFirst({
      where: { id: req.propertyId, tenantId: ctx.tenantId },
    });
    if (!property) {
      throw new DomainError({ code: 'NOT_FOUND', message: 'Property not found', owner: 'Groups' });
    }

    const policy = await this.blocks.getPolicy(ctx, req.propertyId);
    const roomsTotal = req.rooms.reduce((a, r) => a + r.rooms, 0);

    if (roomsTotal < policy.minRoomsForGroup) {
      throw new DomainError({
        code: 'VALIDATION',
        message: `${property.name} treats ${policy.minRoomsForGroup} rooms as the minimum for group business; this request is ${roomsTotal}.`,
        owner: 'Groups',
        remediation: 'Book these rooms through normal availability instead.',
        details: { roomsTotal, minimum: policy.minRoomsForGroup },
      });
    }

    // If the agency named a block, the rooms must actually be there.
    if (req.blockId) {
      const block = await this.blocks.get(ctx, req.blockId);
      if (block.propertyId !== req.propertyId) {
        throw new DomainError({
          code: 'VALIDATION',
          message: 'That block belongs to a different property',
          owner: 'Groups',
        });
      }
      if (block.status !== 'OPEN') {
        throw new DomainError({
          code: 'CONFLICT',
          message: `The block "${block.name}" is ${block.status}, so it is not taking requests.`,
          owner: 'Groups',
        });
      }
      const fit = canBlockTake(block.capacity, req.rooms, req.pax);
      if (!fit.fits) {
        throw new DomainError({
          code: 'CONFLICT',
          message: 'The block cannot take this group.',
          owner: 'Groups',
          remediation: fit.reasons.join(' '),
          details: { reasons: fit.reasons },
        });
      }
    }

    const evaluation = evaluateBid({
      budgetTotal: req.budgetTotal,
      rooms: req.rooms,
      checkIn: req.checkIn,
      checkOut: req.checkOut,
      floorRatePerNight: policy.floorRatePerNight,
      benefits: policy.benefits,
    });

    const now = new Date();
    const expiresAt = bidExpiry(now, policy.responseWindowHours);

    // The hotel switched this on itself, so the platform may act on it — and
    // records that it was the rule, not a person, that declined.
    const autoDeclined = policy.autoDeclineBelowFloor && evaluation.verdict === 'BELOW_FLOOR';

    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.groupRequest.create({
        data: {
          tenantId: ctx.tenantId,
          propertyId: req.propertyId,
          blockId: req.blockId,
          organizationId: ctx.organizationId,
          requestedBy: ctx.userId,
          groupName: req.groupName,
          checkIn: req.checkIn,
          checkOut: req.checkOut,
          pax: req.pax,
          rooms: req.rooms as any,
          budgetTotal: req.budgetTotal,
          currency: req.currency,
          inclusions: req.inclusions,
          notes: req.notes,
          status: autoDeclined ? 'DECLINED' : 'OPEN',
          currentTotal: req.budgetTotal,
          currentActor: 'AGENCY',
          expiresAt,
          settledAt: autoDeclined ? now : null,
          settledBy: autoDeclined ? 'policy:autoDeclineBelowFloor' : null,
          settlement: autoDeclined ? ({ ...evaluation, autoDeclined: true } as any) : undefined,
        },
      });

      await tx.groupBid.create({
        data: {
          requestId: row.id,
          round: 1,
          actor: 'AGENCY',
          actorUserId: ctx.userId,
          total: req.budgetTotal,
          currency: req.currency,
          benefits: [] as any,
          message: req.notes,
          evaluation: evaluation as any,
          expiresAt,
        },
      });

      return row;
    });

    const org = await this.prisma.organization.findUnique({
      where: { id: ctx.organizationId },
      select: { name: true },
    });

    await this.notify(ctx, {
      requestId: created.id,
      template: autoDeclined ? 'group.request.declined' : 'group.request.received',
      policy,
      subject: autoDeclined
        ? `Solicitud de grupo rechazada automáticamente — ${req.groupName}`
        : `Nueva solicitud de grupo: ${req.groupName} (${org?.name ?? 'agencia'})`,
      body: this.composeBody({
        agency: org?.name ?? 'Una agencia',
        propertyName: property.name,
        groupName: req.groupName,
        rooms: req.rooms,
        pax: req.pax,
        checkIn: req.checkIn,
        checkOut: req.checkOut,
        total: req.budgetTotal,
        currency: req.currency,
        hours: policy.responseWindowHours,
        evaluation,
        autoDeclined,
      }),
      payload: {
        requestId: created.id,
        agency: org?.name,
        groupName: req.groupName,
        rooms: roomsTotal,
        pax: req.pax,
        total: req.budgetTotal,
        currency: req.currency,
        expiresAt: expiresAt.toISOString(),
      },
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorType: 'USER',
      actorId: ctx.userId,
      action: 'group.request.created',
      resourceType: 'GroupRequest',
      resourceId: created.id,
      after: {
        groupName: req.groupName,
        rooms: roomsTotal,
        budgetTotal: req.budgetTotal,
        verdict: evaluation.verdict,
        autoDeclined,
      },
      reason: autoDeclined ? 'Auto-declined below the hotel floor rate' : null,
      correlationId: ctx.correlationId,
      ip: ctx.ip,
    });

    return this.get(ctx, created.id);
  }

  /* ── The hotel answers ─────────────────────────────────── */

  async respond(ctx: RequestContext, input: unknown) {
    assertCan(this.principal(ctx), 'groups.negotiate');
    const r = RespondGroupRequestSchema.parse(input);

    const request = await this.prisma.groupRequest.findFirst({
      where: { id: r.requestId, tenantId: ctx.tenantId },
      include: { bids: { orderBy: { round: 'desc' }, take: 1 } },
    });
    if (!request) {
      throw new DomainError({ code: 'NOT_FOUND', message: 'Group request not found', owner: 'Groups' });
    }
    assertCan(this.principal(ctx), 'groups.negotiate', request.propertyId);

    // The buyer cannot answer on the hotel's behalf. Permission is not enough
    // here — an agency legitimately holds groups.negotiate for its own side.
    if (ctx.organizationId === request.organizationId) {
      throw new DomainError({
        code: 'PERMISSION',
        message: 'The agency that raised a request cannot answer it.',
        owner: 'Groups',
        remediation: 'Withdraw the request instead, or wait for the hotel.',
      });
    }

    if (!['OPEN', 'COUNTERED'].includes(request.status)) {
      throw new DomainError({
        code: 'CONFLICT',
        message: `This request is already ${request.status}.`,
        owner: 'Groups',
        remediation:
          request.status === 'EXPIRED'
            ? 'Ask the agency to raise it again — the window closed.'
            : 'A settled negotiation cannot be reopened; a new request starts a new one.',
      });
    }

    const now = new Date();
    if (request.expiresAt <= now) {
      // Losing the race with the sweeper must not silently accept a lapsed
      // offer, so the check is here as well as in the scheduler.
      await this.expire(request.id, 'Expired before the response was recorded');
      throw new DomainError({
        code: 'CONFLICT',
        message: 'The response window for this request has closed.',
        owner: 'Groups',
        remediation: 'Ask the agency to raise it again.',
        details: { expiredAt: request.expiresAt.toISOString() },
      });
    }

    const policy = await this.blocks.getPolicy(ctx, request.propertyId);
    const rooms = (request.rooms as GroupRoomRequest[]) ?? [];
    const lastBid = request.bids[0];
    const onTheTable = toNumber(lastBid?.total) ?? toNumber(request.budgetTotal) ?? 0;

    if (r.decision === 'ACCEPT') {
      return this.accept(ctx, request, rooms, onTheTable, policy, r.message);
    }
    if (r.decision === 'DECLINE') {
      return this.decline(ctx, request, r.message);
    }
    return this.counter(ctx, request, rooms, r.counterTotal!, r.benefitsOffered, policy, r.message);
  }

  private async accept(
    ctx: RequestContext,
    request: any,
    rooms: GroupRoomRequest[],
    total: number,
    policy: any,
    message?: string | null,
  ) {
    // Accepting commits rooms, and committed rooms must leave the sellable
    // pool. Without a block we do not know WHICH room type they come out of, so
    // the accept is refused rather than committing rooms nobody can withdraw.
    if (!request.blockId) {
      throw new DomainError({
        code: 'CONFLICT',
        message:
          'This group is not attached to a block, so the rooms cannot be taken out of sale on acceptance.',
        owner: 'Groups',
        remediation:
          'Attach the request to a group block first. Accepting without one would leave the channel manager selling rooms the hotel has already committed.',
      });
    }

    // Re-check capacity at the moment of acceptance. Availability at the time
    // the offer was made proves nothing about now — another group may have
    // taken the block in between.
    if (request.blockId) {
      // Excluding this request's own hold — it is the thing being converted
      // from held to committed, not a competitor for the same rooms.
      const block = await this.blocks.get(ctx, request.blockId, request.id);
      const fit = canBlockTake(block.capacity, rooms, request.pax);
      if (!fit.fits) {
        throw new DomainError({
          code: 'CONFLICT',
          message: 'The block no longer has room for this group.',
          owner: 'Groups',
          remediation: fit.reasons.join(' '),
          details: { reasons: fit.reasons },
        });
      }
    }

    const evaluation = evaluateBid({
      budgetTotal: total,
      rooms,
      checkIn: request.checkIn,
      checkOut: request.checkOut,
      floorRatePerNight: policy.floorRatePerNight,
      benefits: policy.benefits,
    });

    const updated = await this.prisma.groupRequest.update({
      where: { id: request.id },
      data: {
        status: 'ACCEPTED',
        currentTotal: total,
        settledAt: new Date(),
        settledBy: ctx.userId,
        inventoryStatus: 'PENDING',
        // Snapshot: the floor can move tomorrow, and this decision must still
        // be explainable with the numbers it was actually made on.
        settlement: { ...evaluation, acceptedTotal: total, message: message ?? null } as any,
      },
    });

    // The rooms leave the sellable pool here — in our Effective ARI and, where
    // the connection allows it, at the channel manager the OTAs read from.
    // Accepting and decrementing live in two services and cannot be one
    // transaction, so the outcome is recorded rather than assumed.
    const release = await this.inventory.release(request.id);

    await this.notifyHotelAndAgency(ctx, updated, policy, 'group.request.accepted', {
      subject: `Grupo confirmado — ${request.groupName}`,
      body:
        `El hotel aceptó el grupo "${request.groupName}" por ${money(total, request.currency)}.\n` +
        evaluation.explanation.join('\n') +
        (policy.depositPct ? `\n\nDepósito requerido: ${policy.depositPct}%.` : '') +
        (release.status === 'APPLIED'
          ? `\n\nSe retiraron de la venta ${release.cells} celda(s) de inventario.` +
            (release.pushedToProvider
              ? ' El channel manager ya fue actualizado.'
              : `\n⚠ ${release.pushDetail ?? 'No se pudo avisar al channel manager.'}`)
          : `\n\n⚠ Las habitaciones NO salieron de la venta: ${release.reason}`),
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorType: 'USER',
      actorId: ctx.userId,
      action: 'group.request.accepted',
      resourceType: 'GroupRequest',
      resourceId: request.id,
      before: { status: request.status },
      after: {
        status: 'ACCEPTED',
        total,
        verdict: evaluation.verdict,
        inventoryRelease: release,
      },
      reason: message ?? null,
      correlationId: ctx.correlationId,
      ip: ctx.ip,
    });

    return this.get(ctx, request.id);
  }

  private async decline(ctx: RequestContext, request: any, message?: string | null) {
    const policy = await this.blocks.getPolicy(ctx, request.propertyId);
    await this.prisma.groupRequest.update({
      where: { id: request.id },
      data: { status: 'DECLINED', settledAt: new Date(), settledBy: ctx.userId },
    });

    await this.notifyHotelAndAgency(ctx, request, policy, 'group.request.declined', {
      subject: `Grupo no aceptado — ${request.groupName}`,
      body:
        `El hotel no tomó el grupo "${request.groupName}".` +
        (message ? `\n\nMotivo: ${message}` : ''),
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorType: 'USER',
      actorId: ctx.userId,
      action: 'group.request.declined',
      resourceType: 'GroupRequest',
      resourceId: request.id,
      before: { status: request.status },
      after: { status: 'DECLINED' },
      reason: message ?? null,
      correlationId: ctx.correlationId,
      ip: ctx.ip,
    });

    return this.get(ctx, request.id);
  }

  private async counter(
    ctx: RequestContext,
    request: any,
    rooms: GroupRoomRequest[],
    counterTotal: number,
    benefitsOffered: GroupBenefit[],
    policy: any,
    message?: string | null,
  ) {
    const evaluation = evaluateBid({
      budgetTotal: counterTotal,
      rooms,
      checkIn: request.checkIn,
      checkOut: request.checkOut,
      floorRatePerNight: policy.floorRatePerNight,
      // A counter may sweeten the deal with benefits the standing policy does
      // not include, so the evaluation uses what was actually offered.
      benefits: benefitsOffered.length ? benefitsOffered : policy.benefits,
    });

    const lastRound = await this.prisma.groupBid.aggregate({
      where: { requestId: request.id },
      _max: { round: true },
    });
    const round = (lastRound._max.round ?? 0) + 1;

    // The counter restarts the clock: the ball is in the agency's court now,
    // and they get the same window the hotel had.
    const expiresAt = bidExpiry(new Date(), policy.responseWindowHours);

    await this.prisma.$transaction(async (tx) => {
      await tx.groupBid.create({
        data: {
          requestId: request.id,
          round,
          actor: 'HOTEL',
          actorUserId: ctx.userId,
          total: counterTotal,
          currency: request.currency,
          benefits: benefitsOffered as any,
          message,
          evaluation: evaluation as any,
          expiresAt,
        },
      });
      await tx.groupRequest.update({
        where: { id: request.id },
        data: {
          status: 'COUNTERED',
          currentTotal: counterTotal,
          currentActor: 'HOTEL',
          expiresAt,
        },
      });
    });

    await this.notifyHotelAndAgency(ctx, request, policy, 'group.request.countered', {
      subject: `Contraoferta del hotel — ${request.groupName}`,
      body:
        `El hotel propone ${money(counterTotal, request.currency)} para "${request.groupName}" ` +
        `(ronda ${round}).\n` +
        (benefitsOffered.length
          ? `Beneficios ofrecidos: ${benefitsOffered
              .map((b) => `${b.kind} 1×${b.everyNRooms}`)
              .join(', ')}\n`
          : '') +
        (message ? `\n${message}\n` : '') +
        `\nVence: ${expiresAt.toISOString()}`,
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorType: 'USER',
      actorId: ctx.userId,
      action: 'group.request.countered',
      resourceType: 'GroupRequest',
      resourceId: request.id,
      before: { total: toNumber(request.currentTotal) },
      after: { total: counterTotal, round },
      reason: message ?? null,
      correlationId: ctx.correlationId,
      ip: ctx.ip,
    });

    return this.get(ctx, request.id);
  }

  /** The agency pulls its own request. Only the agency that raised it may. */
  async withdraw(ctx: RequestContext, id: string, reason?: string) {
    assertCan(this.principal(ctx), 'groups.negotiate');
    const request = await this.prisma.groupRequest.findFirst({
      where: { id, tenantId: ctx.tenantId },
    });
    if (!request) {
      throw new DomainError({ code: 'NOT_FOUND', message: 'Group request not found', owner: 'Groups' });
    }
    if (request.organizationId !== ctx.organizationId) {
      throw new DomainError({
        code: 'PERMISSION',
        message: 'Only the agency that raised this request can withdraw it.',
        owner: 'Groups',
      });
    }
    if (!['OPEN', 'COUNTERED'].includes(request.status)) {
      throw new DomainError({
        code: 'CONFLICT',
        message: `This request is already ${request.status}.`,
        owner: 'Groups',
      });
    }

    await this.prisma.groupRequest.update({
      where: { id },
      data: { status: 'WITHDRAWN', settledAt: new Date(), settledBy: ctx.userId },
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorType: 'USER',
      actorId: ctx.userId,
      action: 'group.request.withdrawn',
      resourceType: 'GroupRequest',
      resourceId: id,
      before: { status: request.status },
      after: { status: 'WITHDRAWN' },
      reason: reason ?? null,
      correlationId: ctx.correlationId,
      ip: ctx.ip,
    });

    return this.get(ctx, id);
  }

  /* ── Expiry ────────────────────────────────────────────── */

  async expire(id: string, reason: string): Promise<void> {
    await this.prisma.groupRequest.updateMany({
      // The status guard is the lock: two sweepers cannot both expire the same
      // row, and a request accepted a millisecond earlier is untouched.
      //
      // The reason goes in `settlement`, NOT in `notes`: notes is what the
      // agency wrote when they raised the request, and overwriting it would
      // destroy the only record of what they actually asked for.
      where: { id, status: { in: ['OPEN', 'COUNTERED'] } },
      data: {
        status: 'EXPIRED',
        settledAt: new Date(),
        settledBy: 'system:expiry',
        settlement: { expired: true, reason } as any,
      },
    });
  }

  /**
   * Sweep lapsed offers, and warn before they lapse.
   *
   * The warning matters more than the expiry: a hotel that loses a group
   * because nobody opened the console is the failure this whole feature exists
   * to prevent.
   */
  async sweep(now = new Date()): Promise<{ expired: number; warned: number }> {
    const due = await this.prisma.groupRequest.findMany({
      where: { status: { in: ['OPEN', 'COUNTERED'] }, expiresAt: { lte: now } },
      select: { id: true, tenantId: true, groupName: true, propertyId: true, organizationId: true },
      take: 200,
    });

    for (const r of due) {
      await this.expire(r.id, 'The response window closed with no answer');
      await this.notifications.recordUnaddressed({
        tenantId: r.tenantId,
        requestId: r.id,
        template: 'group.request.expired',
        subject: `Solicitud de grupo vencida — ${r.groupName}`,
        body: `Nadie respondió a tiempo la solicitud "${r.groupName}".`,
      });
    }

    // Two hours out is late enough to be urgent and early enough to act on.
    const soon = new Date(now.getTime() + 2 * 3_600_000);
    const warning = await this.prisma.groupRequest.findMany({
      where: { status: { in: ['OPEN', 'COUNTERED'] }, expiresAt: { gt: now, lte: soon } },
      select: { id: true, tenantId: true, groupName: true, expiresAt: true },
      take: 200,
    });

    let warned = 0;
    for (const r of warning) {
      const already = await this.prisma.notification.count({
        where: { requestId: r.id, template: 'group.request.expiring' },
      });
      if (already > 0) continue;
      await this.notifications.recordUnaddressed({
        tenantId: r.tenantId,
        requestId: r.id,
        template: 'group.request.expiring',
        subject: `Vence pronto — ${r.groupName}`,
        body: `La solicitud "${r.groupName}" vence a las ${r.expiresAt.toISOString()}.`,
      });
      warned += 1;
    }

    return { expired: due.length, warned };
  }

  /* ── Notification plumbing ─────────────────────────────── */

  private async notify(
    ctx: RequestContext,
    args: {
      requestId: string;
      template: any;
      policy: any;
      subject: string;
      body: string;
      payload: Record<string, unknown>;
    },
  ) {
    const recipients = [
      ...args.policy.notifyEmails.map((to: string) => ({ channel: 'EMAIL' as const, to })),
      ...args.policy.notifyWhatsapp.map((to: string) => ({ channel: 'WHATSAPP' as const, to })),
    ];
    if (recipients.length === 0) return;
    await this.notifications.enqueue({
      tenantId: ctx.tenantId,
      correlationId: ctx.correlationId,
      requestId: args.requestId,
      template: args.template,
      recipients,
      subject: args.subject,
      body: args.body,
      payload: args.payload,
    });
  }

  /**
   * Notify the hotel's configured contacts, and the agency's own administrators.
   *
   * The agency side is resolved from their user records rather than a
   * configured list: an agency that raised a request has an account, and the
   * person who needs to know the answer is whoever can act on it. A hotel that
   * counters into silence has not really countered.
   */
  private async notifyHotelAndAgency(
    ctx: RequestContext,
    request: any,
    policy: any,
    template: any,
    msg: { subject: string; body: string },
  ) {
    await this.notify(ctx, {
      requestId: request.id,
      template,
      policy,
      subject: msg.subject,
      body: msg.body,
      payload: { requestId: request.id, groupName: request.groupName },
    });

    const buyers = await this.prisma.user.findMany({
      where: {
        tenantId: ctx.tenantId,
        organizationId: request.organizationId,
        status: 'ACTIVE',
        role: 'AGENCY_ADMIN',
      },
      select: { email: true },
    });
    if (buyers.length === 0) return;

    await this.notifications.enqueue({
      tenantId: ctx.tenantId,
      correlationId: ctx.correlationId,
      requestId: request.id,
      template,
      recipients: buyers.map((b) => ({ channel: 'EMAIL' as const, to: b.email })),
      subject: msg.subject,
      body: msg.body,
      payload: { requestId: request.id, groupName: request.groupName, side: 'AGENCY' },
    });
  }

  /** The message a hotel actually needs to decide, in one screen of text. */
  private composeBody(a: {
    agency: string;
    propertyName: string;
    groupName: string;
    rooms: GroupRoomRequest[];
    pax: number;
    checkIn: string;
    checkOut: string;
    total: number;
    currency: string;
    hours: number;
    evaluation: ReturnType<typeof evaluateBid>;
    autoDeclined: boolean;
  }): string {
    const rooms = a.rooms.map((r) => `${r.rooms} ${BEDDING_LABELS[r.bedding]}`).join(', ');
    return [
      `${a.agency} solicita un grupo en ${a.propertyName}.`,
      '',
      `Grupo:      ${a.groupName}`,
      `Fechas:     ${a.checkIn} → ${a.checkOut}`,
      `Personas:   ${a.pax}`,
      `Habitaciones: ${rooms}`,
      `Presupuesto: ${money(a.total, a.currency)}`,
      '',
      ...a.evaluation.explanation,
      '',
      a.autoDeclined
        ? 'Se rechazó automáticamente por su regla de tarifa mínima.'
        : `Tiene ${a.hours} horas para responder. Si no responde, la solicitud vence.`,
    ].join('\n');
  }
}
