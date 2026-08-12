import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { AriValues, DomainError, StructuredCommand, dateRange } from '@wetriip/contracts';
import { Logger } from '@wetriip/observability';
import { AuditLog } from '@wetriip/persistence';
import { AUDIT_LOG, LOGGER, PRISMA, RequestContext, clients } from '@wetriip/service-kit';

/**
 * Execution runtime.
 *
 * The last step, and the only one that writes. By the time control reaches
 * here the command has been schema-validated, simulated and approved by a
 * human (or by an explicit Level-3 policy). This file does exactly what the
 * command says and nothing more — no interpretation, no fallbacks, no "the
 * user probably meant".
 *
 * Every write goes to the MANAGED layer, never to EXTERNAL. A revenue
 * manager's decision and a channel manager's feed stay distinguishable
 * forever, which is what makes both rollback and reconciliation possible.
 */
@Injectable()
export class ExecutorService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  async execute(
    ctx: RequestContext,
    command: StructuredCommand,
    actionId: string,
  ): Promise<{ summary: string; details: unknown; affectedCells: number }> {
    switch (command.kind) {
      case 'create_promotion': {
        const created = await clients.coreCommerce.post<any>('/internal/core/promotions', ctx, {
          code: command.code,
          name: command.name,
          definition: command.definition,
          validFrom: command.validFrom,
          validTo: command.validTo,
          publish: true,
        });
        return {
          summary: `Promotion "${command.name}" is live.`,
          details: { promotionId: created.id, code: created.code, version: created.version },
          affectedCells: 0,
        };
      }

      case 'update_rates': {
        const cells = await this.targetCells(ctx, command);
        let affected = 0;
        for (const group of groupByRoomRate(cells)) {
          // Each cell can have a different current price, so a percentage
          // change is applied per cell rather than as one blanket amount.
          for (const cell of group.cells) {
            if (cell.baseAmount == null) continue;
            const next =
              command.changeType === 'PERCENTAGE'
                ? round2(cell.baseAmount * (1 + command.value / 100))
                : command.changeType === 'ABSOLUTE'
                  ? round2(cell.baseAmount + command.value)
                  : round2(command.value);
            if (next <= 0) continue;

            await this.applyManaged(ctx, {
              propertyId: command.target.propertyId,
              roomTypeId: group.roomTypeId,
              ratePlanId: group.ratePlanId,
              stayDates: [cell.stayDate],
              occupancy: cell.occupancy,
              values: { baseAmount: next, currency: command.currency ?? cell.currency ?? undefined },
              reason: command.reason ?? `agent action ${actionId}`,
            });
            affected += 1;
          }
        }
        return {
          summary: `Updated rates on ${affected} ARI cell(s).`,
          details: { changeType: command.changeType, value: command.value },
          affectedCells: affected,
        };
      }

      case 'update_availability': {
        const cells = await this.targetCells(ctx, command);
        let affected = 0;
        for (const group of groupByRoomRate(cells)) {
          for (const cell of group.cells) {
            const next =
              command.changeType === 'SET'
                ? Math.max(0, command.value)
                : Math.max(0, cell.available + command.value);
            await this.applyManaged(ctx, {
              propertyId: command.target.propertyId,
              roomTypeId: group.roomTypeId,
              ratePlanId: group.ratePlanId,
              stayDates: [cell.stayDate],
              occupancy: cell.occupancy,
              values: { available: next, allotment: next },
              reason: command.reason ?? `agent action ${actionId}`,
            });
            affected += 1;
          }
        }
        return {
          summary: `Updated availability on ${affected} ARI cell(s).`,
          details: { changeType: command.changeType, value: command.value },
          affectedCells: affected,
        };
      }

      case 'update_restriction': {
        const cells = await this.targetCells(ctx, command);
        const values: AriValues = {};
        const r = command.restriction;
        if (r.open !== undefined && r.open !== null) values.open = r.open;
        if (r.closedToArrival !== undefined && r.closedToArrival !== null)
          values.closedToArrival = r.closedToArrival;
        if (r.closedToDeparture !== undefined && r.closedToDeparture !== null)
          values.closedToDeparture = r.closedToDeparture;
        if (r.minLos != null) values.minLos = r.minLos;
        if (r.maxLos != null) values.maxLos = r.maxLos;
        if (r.releaseDays != null) values.releaseDays = r.releaseDays;

        let affected = 0;
        for (const group of groupByRoomRate(cells)) {
          const dates = group.cells.map((c) => c.stayDate);
          if (!dates.length) continue;
          await this.applyManaged(ctx, {
            propertyId: command.target.propertyId,
            roomTypeId: group.roomTypeId,
            ratePlanId: group.ratePlanId,
            stayDates: dates,
            occupancy: group.cells[0].occupancy,
            values,
            reason: command.reason ?? `agent action ${actionId}`,
          });
          affected += dates.length;
        }
        return {
          summary: `Applied restrictions to ${affected} ARI cell(s).`,
          details: values,
          affectedCells: affected,
        };
      }

      case 'update_promotion': {
        const updated = await clients.coreCommerce.post<any>(
          `/internal/core/promotions/${command.promotionId}/update`,
          ctx,
          { changes: command.changes, reason: command.reason ?? `agent action ${actionId}` },
        );
        return {
          summary: `Promotion "${updated.name}" updated to version ${updated.version}.`,
          details: { promotionId: updated.id, version: updated.version },
          affectedCells: 0,
        };
      }

      case 'set_promotion_status': {
        const updated = await clients.coreCommerce.post<any>(
          `/internal/core/promotions/${command.promotionId}/status`,
          ctx,
          { status: command.status, reason: command.reason ?? `agent action ${actionId}` },
        );
        return {
          summary: `Promotion "${updated.name}" is now ${updated.status} (version ${updated.version}).`,
          details: { promotionId: updated.id, status: updated.status, version: updated.version },
          affectedCells: 0,
        };
      }

      case 'set_group_policy': {
        // Read-modify-write against the owning service: the command carries only
        // the fields the operator mentioned, and everything they did not mention
        // must survive untouched.
        const current = await clients.groups.get<any>(
          `/internal/groups/policy/${command.propertyId}`,
          ctx,
        );
        const saved = await clients.groups.post<any>('/internal/groups/policy', ctx, {
          propertyId: command.propertyId,
          minRoomsForGroup: command.minRoomsForGroup ?? current.minRoomsForGroup,
          floorRatePerNight: command.floorRatePerNight ?? current.floorRatePerNight,
          floorCurrency: command.floorCurrency ?? current.floorCurrency,
          autoDeclineBelowFloor: current.autoDeclineBelowFloor,
          responseWindowHours: command.responseWindowHours ?? current.responseWindowHours,
          depositPct: command.depositPct ?? current.depositPct,
          cancellationPolicy: current.cancellationPolicy,
          benefits: command.benefits ?? current.benefits,
          notifyEmails: current.notifyEmails,
          notifyWhatsapp: current.notifyWhatsapp,
        });
        return {
          summary: `Política de grupos actualizada para la propiedad.`,
          details: { floorRatePerNight: saved.floorRatePerNight, benefits: saved.benefits },
          affectedCells: 0,
        };
      }

      case 'upsert_event_space': {
        const saved = await clients.groups.post<any>('/internal/groups/spaces', ctx, {
          propertyId: command.propertyId,
          code: command.code,
          name: command.name,
          currency: command.currency,
          areaM2: command.areaM2 ?? null,
          ceilingHeightM: null,
          naturalLight: false,
          divisible: false,
          floor: null,
          halfDayHours: 4,
          fullDayHours: 8,
          layouts: command.layouts,
          rates: command.rates,
          addons: command.addons ?? [],
          active: true,
          notes: null,
        });
        return {
          summary: `Salón "${saved.name}" guardado con ${saved.layouts.length} montaje(s).`,
          details: { spaceId: saved.id, maxCapacity: saved.maxCapacity },
          affectedCells: 0,
        };
      }

      case 'respond_group_request': {
        const saved = await clients.groups.post<any>('/internal/groups/requests/respond', ctx, {
          requestId: command.requestId,
          decision: command.decision,
          counterTotal: command.counterTotal ?? null,
          benefitsOffered: [],
          message: command.message ?? null,
        });
        return {
          summary: `Solicitud de grupo "${saved.groupName}" → ${saved.status}.`,
          details: { requestId: saved.id, status: saved.status, total: saved.currentTotal },
          affectedCells: 0,
        };
      }

      case 'rollback_action':
        // Handled by AgentService, which owns the action history.
        throw new DomainError({
          code: 'INTERNAL',
          message: 'rollback_action is executed by the agent orchestrator',
          owner: 'Platform',
        });

      default:
        throw new DomainError({
          code: 'VALIDATION',
          message: `${(command as any).kind} is a read command and has no execution path`,
          owner: 'Platform',
        });
    }
  }

  private async targetCells(ctx: RequestContext, command: { target?: any }) {
    return clients.ari.post<any[]>('/internal/ari/cells-for-target', ctx, {
      propertyId: command.target.propertyId,
      from: command.target.from,
      to: command.target.to,
      roomTypeCodes: command.target.roomTypeCodes ?? null,
      ratePlanCodes: command.target.ratePlanCodes ?? null,
      daysOfWeek: command.target.daysOfWeek ?? null,
      occupancy: command.target.occupancy ?? null,
    });
  }

  private async applyManaged(
    ctx: RequestContext,
    input: {
      propertyId: string;
      roomTypeId: string;
      ratePlanId: string;
      stayDates: string[];
      occupancy: number;
      values: AriValues;
      reason: string;
    },
  ) {
    return clients.ari.post('/internal/ari/managed', ctx, {
      ...input,
      actorType: 'AGENT',
    });
  }
}

function groupByRoomRate(cells: any[]) {
  const map = new Map<string, { roomTypeId: string; ratePlanId: string; cells: any[] }>();
  for (const c of cells) {
    const k = `${c.roomTypeId}|${c.ratePlanId}`;
    const g = map.get(k) ?? { roomTypeId: c.roomTypeId, ratePlanId: c.ratePlanId, cells: [] as any[] };
    g.cells.push(c);
    map.set(k, g);
  }
  return [...map.values()];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
