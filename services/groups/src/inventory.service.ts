import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import {
  DomainError,
  GroupRoomRequest,
  addDays,
  newCorrelationId,
  nightsBetween,
} from '@wetriip/contracts';
import { Logger } from '@wetriip/observability';
import { AuditLog } from '@wetriip/persistence';
import { AUDIT_LOG, LOGGER, PRISMA, RequestContext, clients, systemContext } from '@wetriip/service-kit';

/**
 * Taking group rooms out of sale.
 *
 * When a hotel commits ten rooms to a group, those ten rooms must stop being
 * sellable to everyone else — in our own Effective ARI *and* at the channel
 * manager, which is where the OTAs read from. A block that only exists inside
 * Wetriip is a block that gets oversold by Booking.com on a Tuesday.
 *
 * Four decisions shape this:
 *
 *  1. **Only ACCEPTED decrements.** A negotiation in progress holds inventory
 *     inside the block so two agencies cannot both be told yes, but it must not
 *     touch real availability — an offer that lapses would otherwise have
 *     silently withheld rooms from sale for a day.
 *  2. **The write is MANAGED, never EXTERNAL.** The hotel's commercial decision
 *     and the channel manager's feed stay distinguishable forever, which is what
 *     makes reconciliation and reversal possible at all. Rule 3 of the platform.
 *  3. **It runs as the SYSTEM, not as the person who clicked accept.** The
 *     decrement is not a discretionary write — it is the mechanical consequence
 *     of a commitment. Requiring `availability.write` to accept a group would
 *     mean a reservations manager could commit the rooms but not remove them,
 *     which is the worst of both.
 *  4. **The outcome is recorded, including failure.** Accepting a group and
 *     decrementing inventory are in two different services and cannot be one
 *     transaction. Rather than pretend, the request carries the release status:
 *     APPLIED with the cell count, or FAILED with the reason, visible in the
 *     console and retryable. A silent failure here is an oversell.
 */
@Injectable()
export class InventoryService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  /**
   * The nights a stay actually occupies.
   *
   * Check-in 10th, check-out 13th occupies the 10th, 11th and 12th — three
   * nights, and the 13th is somebody else's to sell. Including the departure
   * date would withhold a night per group for no reason.
   */
  static occupiedNights(checkIn: string, checkOut: string): string[] {
    const nights = Math.max(1, nightsBetween(checkIn, checkOut));
    return Array.from({ length: nights }, (_, i) => addDays(checkIn, i));
  }

  /**
   * Which room type each requested bedding maps onto.
   *
   * Bedding is how a room is made up, not a different room. Ten DOUBLE and five
   * TWIN on the same room type are fifteen rooms out of one pool, so they are
   * summed per room type before anything is decremented.
   */
  private async roomsByRoomType(
    blockId: string,
    requested: GroupRoomRequest[],
  ): Promise<Map<string, number>> {
    const lines = await this.prisma.groupBlockLine.findMany({ where: { blockId } });
    const byRoomType = new Map<string, number>();

    for (const req of requested) {
      const line = lines.find((l) => l.bedding === req.bedding);
      if (!line) {
        throw new DomainError({
          code: 'CONFLICT',
          message: `The block has no ${req.bedding} line, so there is no room type to take these rooms from.`,
          owner: 'Groups',
          remediation: 'Add that bedding to the block before accepting the group.',
        });
      }
      byRoomType.set(line.roomTypeId, (byRoomType.get(line.roomTypeId) ?? 0) + req.rooms);
    }
    return byRoomType;
  }

  /**
   * Apply the decrement. Idempotent by status: a request already APPLIED is a
   * no-op, so a retry after a partial failure cannot double-subtract.
   */
  async release(requestId: string): Promise<{
    status: 'APPLIED' | 'FAILED' | 'NOT_REQUIRED';
    cells: number;
    nights: number;
    roomTypes: number;
    pushedToProvider: boolean;
    pushDetail: string | null;
    /** Room-nights the published pool could not absorb. Non-zero means the
     *  hotel is committed to rooms its own channel manager does not show. */
    shortfall: number;
    reason: string | null;
  }> {
    const request = await this.prisma.groupRequest.findUnique({ where: { id: requestId } });
    if (!request) {
      throw new DomainError({ code: 'NOT_FOUND', message: 'Group request not found', owner: 'Groups' });
    }

    if (request.status !== 'ACCEPTED') {
      return {
        status: 'NOT_REQUIRED',
        cells: 0,
        nights: 0,
        roomTypes: 0,
        pushedToProvider: false,
        pushDetail: null,
        shortfall: 0,
        reason: 'Only an accepted group takes rooms out of sale.',
      };
    }
    if (request.inventoryStatus === 'APPLIED') {
      const prior = (request.inventoryDetail as any) ?? {};
      return {
        status: 'APPLIED',
        cells: prior.cells ?? 0,
        nights: prior.nights ?? 0,
        roomTypes: prior.roomTypes ?? 0,
        pushedToProvider: prior.pushedToProvider ?? false,
        pushDetail: prior.pushDetail ?? null,
        shortfall: prior.shortfall ?? 0,
        reason: 'Already applied.',
      };
    }

    if (!request.blockId) {
      // Without a block we do not know WHICH room type to take the rooms from.
      // Guessing would decrement the wrong pool, which is worse than refusing.
      return this.record(request.id, 'FAILED', {
        reason:
          'This group is not attached to a block, so no room type is known and nothing can be taken out of sale.',
      });
    }

    const ctx: RequestContext = systemContext({
      tenantId: request.tenantId,
      actor: 'group-inventory-release',
      correlationId: newCorrelationId(),
    });

    try {
      const rooms = (request.rooms as GroupRoomRequest[]) ?? [];
      const byRoomType = await this.roomsByRoomType(request.blockId, rooms);
      const nights = InventoryService.occupiedNights(request.checkIn, request.checkOut);

      // Read the live cells once for the whole window, then decide per cell.
      // A percentage of a stale number is how availability drifts negative.
      const cells = await clients.ari.post<any[]>('/internal/ari/cells-for-target', ctx, {
        propertyId: request.propertyId,
        from: nights[0],
        to: nights[nights.length - 1],
        roomTypeCodes: null,
        ratePlanCodes: null,
        daysOfWeek: null,
        occupancy: null,
      });

      let applied = 0;
      // Rooms the pool could not absorb. A block is DECLARED inventory — the
      // hotel says it holds twenty back — but the channel manager may only have
      // published two for a given night. Flooring at zero silently would hide
      // exactly the oversell this whole feature exists to prevent, so the
      // difference is counted and reported.
      let shortfall = 0;
      const shortfallNights: { stayDate: string; wanted: number; had: number }[] = [];
      const touchedRoomTypes = new Set<string>();
      const pushCommands: any[] = [];

      for (const [roomTypeId, roomsTaken] of byRoomType) {
        const mine = cells.filter(
          (c) => c.roomTypeId === roomTypeId && nights.includes(c.stayDate),
        );
        for (const cell of mine) {
          // Availability is stored per room/rate cell, but the rooms are one
          // physical pool shared across rate plans. Taking ten rooms means every
          // plan on that room type can sell ten fewer — which is exactly how a
          // channel manager mirrors availability.
          const had = cell.available ?? 0;
          const next = Math.max(0, had - roomsTaken);
          if (had < roomsTaken) {
            shortfall += roomsTaken - had;
            shortfallNights.push({ stayDate: cell.stayDate, wanted: roomsTaken, had });
          }
          await clients.ari.post('/internal/ari/managed', ctx, {
            propertyId: request.propertyId,
            roomTypeId,
            ratePlanId: cell.ratePlanId,
            stayDates: [cell.stayDate],
            occupancy: cell.occupancy,
            values: { available: next, allotment: next },
            reason: `group ${request.groupName} (${request.id}) — ${roomsTaken} room(s) committed`,
            actorType: 'AGENT',
          });
          applied += 1;
          touchedRoomTypes.add(roomTypeId);
          pushCommands.push({
            type: 'AVAILABILITY',
            roomTypeId,
            ratePlanId: cell.ratePlanId,
            stayDate: cell.stayDate,
            available: next,
          });
        }
      }

      if (applied === 0) {
        return this.record(request.id, 'FAILED', {
          reason:
            'No ARI cells exist for those room types and dates, so there was no availability to reduce. ' +
            'The channel manager has never sent inventory for this window.',
          nights: nights.length,
          roomTypes: byRoomType.size,
        });
      }

      // ── Outward, to where the OTAs actually read from ──────
      const push = await this.pushToProvider(ctx, request.propertyId, pushCommands);

      const detail = {
        cells: applied,
        nights: nights.length,
        roomTypes: touchedRoomTypes.size,
        rooms: [...byRoomType.entries()].map(([roomTypeId, r]) => ({ roomTypeId, rooms: r })),
        window: { from: nights[0], to: nights[nights.length - 1] },
        pushedToProvider: push.pushed,
        pushDetail: push.detail,
        shortfall,
        shortfallNights: shortfallNights.slice(0, 20),
        shortfallDetail:
          shortfall > 0
            ? `The block promised more rooms than the channel manager has published. ` +
              `${shortfall} room-night(s) could not be withdrawn because availability was already lower ` +
              `— on ${shortfallNights.length} cell(s), the worst being ${shortfallNights[0]?.wanted} wanted ` +
              `against ${shortfallNights[0]?.had} available. The hotel is committed to rooms its own feed does not show.`
            : null,
      };

      await this.prisma.groupRequest.update({
        where: { id: request.id },
        data: {
          inventoryStatus: 'APPLIED',
          inventoryDetail: detail as any,
          inventoryAppliedAt: new Date(),
        },
      });

      await this.audit.record({
        tenantId: request.tenantId,
        actorType: 'SYSTEM',
        actorId: 'group-inventory-release',
        action: 'group.inventory.released',
        resourceType: 'GroupRequest',
        resourceId: request.id,
        after: detail,
        reason: `Group accepted — ${applied} ARI cell(s) reduced`,
        correlationId: ctx.correlationId,
      });

      if (shortfall > 0) {
        this.log.warn('group committed beyond published availability', {
          requestId: request.id,
          shortfall,
          correlationId: ctx.correlationId,
        });
      }

      this.log.info('group inventory released', {
        requestId: request.id,
        cells: applied,
        shortfall,
        pushed: push.pushed,
        correlationId: ctx.correlationId,
      });

      return {
        status: 'APPLIED',
        cells: applied,
        nights: nights.length,
        roomTypes: touchedRoomTypes.size,
        pushedToProvider: push.pushed,
        pushDetail: push.detail,
        shortfall,
        reason: detail.shortfallDetail,
      };
    } catch (err) {
      const reason = err instanceof DomainError ? err.message : String(err);
      this.log.warn('group inventory release failed', { requestId: request.id, error: reason });
      return this.record(request.id, 'FAILED', { reason });
    }
  }

  /**
   * Push the new availability to the channel manager.
   *
   * A failure here does NOT fail the release: our own Effective ARI is already
   * correct, so Wetriip will not oversell. What it means is that the OTAs still
   * see the old number, which is an alarm the hotel must act on — so it is
   * recorded and surfaced rather than swallowed.
   */
  private async pushToProvider(
    ctx: RequestContext,
    propertyId: string,
    commands: any[],
  ): Promise<{ pushed: boolean; detail: string | null }> {
    const connection = await this.prisma.connection.findFirst({
      where: { propertyId, status: { in: ['ACTIVE', 'PENDING'] }, mode: { in: ['PUSH', 'BOTH'] } },
    });
    if (!connection) {
      return {
        pushed: false,
        detail:
          'No outbound connection for this property. Reduce the rooms in the channel manager by hand, or the OTAs will keep selling them.',
      };
    }

    try {
      const res = await clients.connectivity.post<any>(
        `/internal/connectivity/connections/${connection.id}/push`,
        ctx,
        { commands },
      );
      return {
        pushed: true,
        detail: `${commands.length} availability command(s) accepted by ${connection.provider}${
          res?.accepted != null ? ` (${res.accepted} accepted)` : ''
        }.`,
      };
    } catch (err) {
      const message = err instanceof DomainError ? err.message : String(err);
      return {
        pushed: false,
        detail:
          `${connection.provider} did not accept the availability push: ${message} ` +
          'Wetriip will not oversell, but the OTAs still see the old number until this is fixed.',
      };
    }
  }

  private async record(
    requestId: string,
    status: 'FAILED',
    detail: Record<string, unknown>,
  ): Promise<any> {
    await this.prisma.groupRequest.update({
      where: { id: requestId },
      data: { inventoryStatus: status, inventoryDetail: detail as any },
    });
    return {
      status,
      cells: 0,
      nights: (detail.nights as number) ?? 0,
      roomTypes: (detail.roomTypes as number) ?? 0,
      pushedToProvider: false,
      pushDetail: null,
      shortfall: 0,
      reason: (detail.reason as string) ?? null,
    };
  }

  /**
   * Retry every accepted group whose rooms never came out of sale.
   *
   * This is the failure that must not sit quietly: the hotel believes the rooms
   * are gone and the channel manager is still selling them.
   */
  async retryFailed(limit = 25): Promise<{ retried: number; recovered: number }> {
    const stuck = await this.prisma.groupRequest.findMany({
      where: { status: 'ACCEPTED', inventoryStatus: { in: ['PENDING', 'FAILED'] } },
      select: { id: true },
      take: limit,
    });

    let recovered = 0;
    for (const r of stuck) {
      const res = await this.release(r.id).catch(() => null);
      if (res?.status === 'APPLIED') recovered += 1;
    }
    return { retried: stuck.length, recovered };
  }
}
