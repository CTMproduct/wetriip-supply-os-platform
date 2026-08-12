import { Injectable } from '@nestjs/common';
import {
  AriHealthRow,
  ConnectionHealthSnapshot,
  DiagnosticReport,
  DomainError,
  EffectiveAriRow,
  PromotionRef,
  StructuredCommand,
  addDays,
  toStayDate,
} from '@wetriip/contracts';
import { SimCell } from '@wetriip/domain';
import { RequestContext, clients } from '@wetriip/service-kit';

/**
 * The deterministic tool layer.
 *
 * Every capability the agent has is a function here, and each one is a plain
 * service call the same as any REST client would make. There is no path from a
 * model to the database that does not go through this file, and nothing here
 * takes free text as a parameter — only typed fields off a validated command.
 *
 * Read tools answer questions. They run at autonomy Level 1 without
 * confirmation because they change nothing.
 */
@Injectable()
export class ToolsService {
  async runRead(
    ctx: RequestContext,
    command: StructuredCommand,
  ): Promise<{ data: unknown; speech: string }> {
    switch (command.kind) {
      case 'explain_no_sales': {
        const qs = new URLSearchParams({ propertyId: command.propertyId });
        if (command.from) qs.set('from', command.from);
        if (command.to) qs.set('to', command.to);
        if (command.market) qs.set('market', command.market);
        const report = await clients.search.get<DiagnosticReport & { compSetBasis: string }>(
          `/internal/search/diagnose?${qs.toString()}`,
          ctx,
        );
        return { data: report, speech: this.narrateDiagnosis(report) };
      }

      case 'get_availability': {
        const rows = await clients.ari.get<EffectiveAriRow[]>(
          `/internal/ari/effective?propertyId=${command.propertyId}&from=${command.from}&to=${command.to}`,
          ctx,
        );
        const open = rows.filter((r) => r.open && r.available > 0);
        const totalRooms = open.reduce((s, r) => s + r.available, 0);
        const closedDates = [...new Set(rows.filter((r) => !r.open).map((r) => r.stayDate))];
        return {
          data: rows,
          speech:
            rows.length === 0
              ? `I have no inventory data at all between ${command.from} and ${command.to}. That is a connectivity problem, not a sold-out hotel.`
              : `Between ${command.from} and ${command.to} you have ${totalRooms} room-nights open across ${open.length} rate cells.` +
                (closedDates.length
                  ? ` ${closedDates.length} date(s) are closed: ${closedDates.slice(0, 6).join(', ')}${closedDates.length > 6 ? '…' : ''}.`
                  : ''),
        };
      }

      case 'get_ari_health': {
        const from = command.from ?? toStayDate(new Date());
        const to = command.to ?? addDays(from, 30);
        const report = await clients.ari.get<{
          rows: AriHealthRow[];
          summary: Record<string, number>;
        }>(`/internal/ari/health-report?propertyId=${command.propertyId}&from=${from}&to=${to}`, ctx);

        const broken = report.rows.filter((r) => r.status === 'BROKEN' || r.status === 'NO_DATA');
        return {
          data: report,
          speech:
            broken.length === 0
              ? `All ${report.summary.combinations} room/rate combinations are receiving inventory within SLA.`
              : `${broken.length} of ${report.summary.combinations} room/rate combinations are unhealthy. ` +
                broken
                  .slice(0, 3)
                  .map((b) => `${b.roomTypeCode}/${b.ratePlanCode}: ${b.causes[0] ?? b.status}`)
                  .join(' '),
        };
      }

      case 'get_connectivity_health': {
        const rows = await clients.connectivity.get<ConnectionHealthSnapshot[]>(
          `/internal/connectivity/health${command.propertyId ? `?propertyId=${command.propertyId}` : ''}`,
          ctx,
        );
        const withIssues = rows.filter((r) => r.issues.length > 0);
        return {
          data: rows,
          speech: withIssues.length
            ? `${withIssues.length} of ${rows.length} connection(s) need attention. ${withIssues
                .slice(0, 3)
                .map((r) => `${r.provider}: ${r.issues[0]}`)
                .join(' ')}`
            : `All ${rows.length} connection(s) are healthy.`,
        };
      }

      case 'list_promotions': {
        const rows = await clients.coreCommerce.get<PromotionRef[]>(
          `/internal/core/promotions?propertyId=${command.propertyId}`,
          ctx,
        );
        const active = rows.filter((r) => r.status === 'ACTIVE');
        return {
          data: rows,
          speech: rows.length
            ? `${active.length} active promotion(s) of ${rows.length} total: ${active
                .slice(0, 4)
                .map((p) => p.name)
                .join(', ')}.`
            : 'No promotions configured for this property.',
        };
      }

      case 'get_revenue_advisory': {
        const qs = new URLSearchParams({ propertyId: command.propertyId });
        if (command.from) qs.set('from', command.from);
        if (command.to) qs.set('to', command.to);
        const advisory = await clients.search.get<any>(
          `/internal/search/revenue-advisory?${qs.toString()}`,
          ctx,
        );
        return { data: advisory, speech: advisory.headline };
      }

      case 'list_group_requests': {
        const qs = new URLSearchParams({ propertyId: command.propertyId });
        if (command.status) qs.set('status', command.status);
        const rows = await clients.groups.get<any[]>(
          `/internal/groups/requests?${qs.toString()}`,
          ctx,
        );
        return { data: rows, speech: this.narrateGroupRequests(rows) };
      }

      case 'get_event_spaces': {
        const rows = await clients.groups.get<any[]>(
          `/internal/groups/spaces?propertyId=${command.propertyId}`,
          ctx,
        );
        return { data: rows, speech: this.narrateEventSpaces(rows) };
      }

      case 'get_partner_production': {
        const rows = await clients.search.get<any[]>(
          `/internal/search/partner-production?propertyId=${command.propertyId}&sinceDays=${command.sinceDays ?? 90}`,
          ctx,
        );
        const ranked = [...rows]
          .filter((r) => r.netRevenue != null && r.roomNights > 0)
          .sort((a, b) => b.netRevenue / b.roomNights - a.netRevenue / a.roomNights);
        return {
          data: rows,
          speech: ranked.length
            ? `${rows.length} partner(s) produced business. Ranked by net revenue per room night, ${ranked[0].name} leads.`
            : 'No partner production recorded in this window.',
        };
      }

      default:
        throw new DomainError({
          code: 'VALIDATION',
          message: `${command.kind} is not a read command`,
          owner: 'Platform',
        });
    }
  }

  /** Current state of every cell a write command would touch. This is the
   *  simulation's only input, so a command's blast radius is measured against
   *  live data rather than assumed. */
  async cellsForCommand(ctx: RequestContext, command: StructuredCommand): Promise<SimCell[]> {
    if (command.kind === 'create_promotion') {
      const d = command.definition;
      return clients.ari.post<SimCell[]>('/internal/ari/cells-for-target', ctx, {
        propertyId: d.scope.propertyId,
        from: d.stayWindow.from,
        to: d.stayWindow.to,
        roomTypeCodes: d.scope.roomTypeCodes ?? null,
        ratePlanCodes: d.scope.ratePlanCodes ?? null,
        daysOfWeek: d.stayWindow.daysOfWeek ?? null,
        occupancy: null,
      });
    }
    if ('target' in command) {
      return clients.ari.post<SimCell[]>('/internal/ari/cells-for-target', ctx, {
        propertyId: command.target.propertyId,
        from: command.target.from,
        to: command.target.to,
        roomTypeCodes: command.target.roomTypeCodes ?? null,
        ratePlanCodes: command.target.ratePlanCodes ?? null,
        daysOfWeek: command.target.daysOfWeek ?? null,
        occupancy: command.target.occupancy ?? null,
      });
    }
    return [];
  }


  /**
   * The deadline first. A hotel scanning a list of group requests needs to know
   * what lapses today before it needs to know anything else about them.
   */
  private narrateGroupRequests(rows: any[]): string {
    if (rows.length === 0) return 'No hay solicitudes de grupo para esta propiedad.';

    const live = rows.filter((r) => r.status === 'OPEN' || r.status === 'COUNTERED');
    const urgent = live.filter((r) => r.hoursRemaining <= 6);

    const lines = [
      `${rows.length} solicitud(es); ${live.length} esperando respuesta.`,
      ...(urgent.length
        ? [`⚠ ${urgent.length} vence(n) en menos de 6 horas.`]
        : []),
      ...live
        .slice(0, 6)
        .map(
          (r) =>
            `· ${r.agencyName} — "${r.groupName}", ${r.roomsTotal} hab, ${r.pax} pax, ` +
            `${r.checkIn}→${r.checkOut}, ${r.currentTotal} ${r.currency}, ` +
            `quedan ${r.hoursRemaining} h. [${r.id}]`,
        ),
    ];
    return lines.join('\n');
  }

  private narrateEventSpaces(rows: any[]): string {
    if (rows.length === 0) {
      return 'Esta propiedad no tiene salones cargados todavía. Puede dictarlos: nombre, capacidades por montaje y tarifas.';
    }
    return rows
      .map((s) => {
        const caps = (s.layouts ?? [])
          .map((l: any) => `${l.label} ${l.capacity}`)
          .join(', ');
        const rates = (s.rates ?? []).map((r: any) => `${r.unit} ${r.amount}`).join(', ');
        return `· ${s.name} (${s.code}) — hasta ${s.maxCapacity} pax. ${caps}. ${rates} ${s.currency}.`;
      })
      .join('\n');
  }

  private narrateDiagnosis(report: DiagnosticReport & { compSetBasis?: string }): string {
    if (report.findings.length === 0) return report.summary;
    const numbered = report.findings
      .slice(0, 4)
      .map((f, i) => `${i + 1}. ${f.title}`)
      .join(' ');
    const fixable = report.findings.filter((f) => f.autoFixable).length;
    return (
      `${report.summary} ${numbered}` +
      (fixable > 0
        ? ` I can prepare a change for ${fixable} of them — you would still confirm before anything is applied.`
        : '')
    );
  }
}
