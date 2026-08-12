import { Injectable } from '@nestjs/common';
import {
  ContractRef,
  DiagnosticReport,
  PartnerProduction,
  PromotionRef,
  PropertyRef,
  RevenueAdvisory,
  ToolStep,
  addDays,
  toStayDate,
} from '@wetriip/contracts';
import { RequestContext, clients } from '@wetriip/service-kit';

/**
 * The assistant's read surface.
 *
 * Every one of these changes nothing, which is why they execute immediately
 * without confirmation. The single write path is `propose_change`, and it lives
 * in the conversation service where the policy and simulation engines are.
 *
 * Each tool returns both a compact result for the model and a `card` the
 * console can render as a table or a metric strip instead of prose — the same
 * data, shaped for two different readers.
 */
export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolOutcome {
  result: unknown;
  summary: string;
  card?: ToolStep['card'];
}

const dateProps = {
  from: { type: 'string', description: 'ISO yyyy-mm-dd. Defaults to today.' },
  to: { type: 'string', description: 'ISO yyyy-mm-dd. Defaults to 30 days out.' },
};

export const CHAT_TOOLS: ToolDefinition[] = [
  {
    name: 'list_properties',
    label: 'Listing properties',
    description:
      'List the properties this user can see, with their id, code, city, currency and approval status. Call this first when the user names a hotel instead of selecting one.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_organizations',
    label: 'Listing partners',
    description:
      'List organizations in the tenant (agencies, wholesalers, OTAs, corporates) with their ids. Required before building an agency-exclusive promotion — never guess an organizationId.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_revenue_advisory',
    label: 'Reading revenue performance',
    description:
      'The core analysis: occupancy, ADR, RevPAR, booking pace, length-of-stay pattern, day-of-week spread, competitive rate position, partner production and a set of computed findings. Each metric carries a confidence grade based on sample size. Call this for anything about performance, pricing or "how do I improve".',
    input_schema: {
      type: 'object',
      properties: { propertyId: { type: 'string' }, ...dateProps },
      required: ['propertyId'],
    },
  },
  {
    name: 'get_partner_production',
    label: 'Reading partner production',
    description:
      'Production by buyer organization: bookings, room nights, revenue, ADR, average length of stay, lead time, cancellation rate, commission and NET revenue. Use net contribution per room night to rank partners, never gross.',
    input_schema: {
      type: 'object',
      properties: {
        propertyId: { type: 'string' },
        sinceDays: { type: 'number', description: 'Lookback window in days. Default 90.' },
      },
      required: ['propertyId'],
    },
  },
  {
    name: 'diagnose_no_sales',
    label: 'Diagnosing the funnel',
    description:
      'Walks the funnel from searches to conversion and separates technical failures (mapping, stale ARI, restrictions, contracts) from commercial ones (price position). Call this when a hotel says it is not selling.',
    input_schema: {
      type: 'object',
      properties: { propertyId: { type: 'string' }, ...dateProps },
      required: ['propertyId'],
    },
  },
  {
    name: 'get_availability',
    label: 'Reading availability',
    description:
      'Effective ARI per date: price, rooms open, restrictions, freshness and which layer produced each value.',
    input_schema: {
      type: 'object',
      properties: { propertyId: { type: 'string' }, ...dateProps },
      required: ['propertyId'],
    },
  },
  {
    name: 'get_ari_health',
    label: 'Checking inventory health',
    description:
      'Coverage, freshness, gaps, rejections and root cause per room type and rate plan.',
    input_schema: {
      type: 'object',
      properties: { propertyId: { type: 'string' }, ...dateProps },
      required: ['propertyId'],
    },
  },
  {
    name: 'get_connectivity_health',
    label: 'Checking connections',
    description:
      'Channel manager connection status, last event, rejections, circuit state and outstanding issues.',
    input_schema: {
      type: 'object',
      properties: { propertyId: { type: 'string' } },
    },
  },
  {
    name: 'list_promotions',
    label: 'Listing promotions',
    description:
      'Promotions for a property with their full rule definition, status and version. Required before updating or pausing one — you need the promotionId.',
    input_schema: {
      type: 'object',
      properties: { propertyId: { type: 'string' } },
      required: ['propertyId'],
    },
  },
  {
    name: 'list_contracts',
    label: 'Reading contracts',
    description:
      'Contracts with buyers: payment model, commission, markup, markets, channels, validity and resale depth.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_property_content',
    label: 'Reading the hotel profile',
    description:
      'The effective hotel profile: description, address, amenities, check-in times, policies and gallery, with field-by-field provenance and a completeness score. Use it when asked about the profile, photos or what is missing from a listing.',
    input_schema: {
      type: 'object',
      properties: {
        propertyId: { type: 'string' },
        locale: { type: 'string', description: 'Defaults to es.' },
      },
      required: ['propertyId'],
    },
  },
  {
    name: 'get_distribution_reach',
    label: 'Checking distribution reach',
    description:
      'Who can currently see this hotel and who cannot, with the exact rule that blocks each one. Use it for questions about marketplace exposure, geo restrictions or partner-exclusive distribution.',
    input_schema: {
      type: 'object',
      properties: { propertyId: { type: 'string' } },
      required: ['propertyId'],
    },
  },
  {
    name: 'list_partners',
    label: 'Reading partner directory',
    description:
      'Wholesalers and agencies with their partner code, tax identity, payment terms, credit line and utilization. Required before building an agency-exclusive rule or answering a credit question.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_property_demand',
    label: 'Reading demand',
    description:
      'Per-buyer demand for this hotel: impressions, how many produced an offer, what blocked the rest, bookings and conversion. This is how you answer "who is looking at me and not booking".',
    input_schema: {
      type: 'object',
      properties: {
        propertyId: { type: 'string' },
        days: { type: 'number', description: 'Lookback window. Default 30.' },
      },
      required: ['propertyId'],
    },
  },
  {
    name: 'get_travel_flow',
    label: 'Reading travel flow',
    description:
      'Outbound or inbound travel flow observed on this platform. OUTBOUND anchors on a source market (where are buyers from Colombia searching). INBOUND anchors on a destination country (who is looking at Colombia). Includes a trend against the previous window.',
    input_schema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['OUTBOUND', 'INBOUND'] },
        anchor: { type: 'string', description: 'ISO-3166 alpha-2 country code.' },
        days: { type: 'number' },
      },
      required: ['direction', 'anchor'],
    },
  },
  {
    name: 'list_group_requests',
    label: 'Reading group requests',
    description:
      'Group requests raised by agencies for this hotel: the agency name, rooms by bedding, pax, the money on the table, how it compares to the hotel floor rate, and hours remaining before the offer lapses. Call this before answering anything about groups — the deadline is the part that matters.',
    input_schema: {
      type: 'object',
      properties: {
        propertyId: { type: 'string' },
        status: {
          type: 'string',
          enum: ['OPEN', 'COUNTERED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN'],
        },
      },
      required: ['propertyId'],
    },
  },
  {
    name: 'get_group_policy',
    label: 'Reading group policy',
    description:
      'What this hotel will accept for group business: minimum rooms, floor rate, response window, deposit, and the benefit rules such as one free room per twenty paid. Read it before advising on a group offer.',
    input_schema: {
      type: 'object',
      properties: { propertyId: { type: 'string' } },
      required: ['propertyId'],
    },
  },
  {
    name: 'list_event_spaces',
    label: 'Reading event spaces',
    description:
      'Meeting rooms with their capacity per layout (theatre, U-shape, classroom, banquet), their hourly/half-day/full-day rates, and the equipment and catering they offer with prices.',
    input_schema: {
      type: 'object',
      properties: { propertyId: { type: 'string' } },
      required: ['propertyId'],
    },
  },
  {
    name: 'quote_event_space',
    label: 'Quoting an event',
    description:
      'Price an event: it picks the cheapest applicable rate unit, validates that the group fits the chosen layout, adds setup, equipment and catering, and applies the property tax. Returns every line with its arithmetic. This is a quote, not a booking — nothing is held.',
    input_schema: {
      type: 'object',
      properties: {
        spaceId: { type: 'string' },
        date: { type: 'string', description: 'ISO yyyy-mm-dd.' },
        layout: {
          type: 'string',
          enum: ['THEATRE', 'CLASSROOM', 'U_SHAPE', 'L_SHAPE', 'BOARDROOM', 'IMPERIAL', 'BANQUET', 'COCKTAIL', 'CABARET'],
        },
        pax: { type: 'number' },
        hours: { type: 'number', description: 'Omit to price a full day.' },
        days: { type: 'number' },
        addons: {
          type: 'array',
          description: 'e.g. [{ "kind": "COFFEE_BREAK", "quantity": 1 }, { "kind": "VIDEOBEAM", "quantity": 1 }]',
          items: {
            type: 'object',
            properties: { kind: { type: 'string' }, quantity: { type: 'number' } },
            required: ['kind'],
          },
        },
      },
      required: ['spaceId', 'date', 'layout', 'pax'],
    },
  },
  {
    name: 'propose_change',
    label: 'Preparing a change',
    description:
      'Prepare a change for the user to confirm. This does NOT execute anything: it validates the command, simulates it against live inventory, evaluates policy and returns a proposal with its blast radius. The human confirms it in the interface. Use it whenever the user asks for something to be changed.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'object',
          description:
            'A StructuredCommand. Its shapes are documented in your system prompt. If it fails validation you will get the exact issues back and may correct it once.',
        },
        rationale: {
          type: 'string',
          description: 'One sentence on why this change, in the user language. Shown with the proposal.',
        },
      },
      required: ['command'],
    },
  },
];

@Injectable()
export class ChatToolsService {
  async run(ctx: RequestContext, name: string, input: any): Promise<ToolOutcome> {
    switch (name) {
      case 'list_properties': {
        const rows = await clients.coreCommerce.get<PropertyRef[]>(
          '/internal/core/properties',
          ctx,
        );
        return {
          result: rows.map((p) => ({
            id: p.id,
            code: p.code,
            name: p.name,
            city: p.city,
            country: p.country,
            currency: p.currency,
            status: p.status,
          })),
          summary: `${rows.length} property(ies)`,
          card: { type: 'properties', data: rows },
        };
      }

      case 'list_organizations': {
        const rows = await clients.coreCommerce.get<any[]>('/internal/core/organizations', ctx);
        return {
          result: rows,
          summary: `${rows.length} organization(s)`,
          card: { type: 'organizations', data: rows },
        };
      }

      case 'get_revenue_advisory': {
        const qs = this.window(input);
        const advisory = await clients.search.get<RevenueAdvisory>(
          `/internal/search/revenue-advisory?propertyId=${input.propertyId}${qs}`,
          ctx,

        );
        return {
          result: {
            headline: advisory.headline,
            window: advisory.window,
            currency: advisory.metrics.currency,
            metrics: {
              occupancy: advisory.metrics.occupancy,
              adr: advisory.metrics.adr,
              revpar: advisory.metrics.revpar,
              roomNightsAvailable: advisory.metrics.roomNightsAvailable,
              roomNightsSold: advisory.metrics.roomNightsSold,
              roomRevenue: advisory.metrics.roomRevenue,
              bookingCount: advisory.metrics.bookingCount,
              confidence: advisory.metrics.confidence,
              averageOfferedRate: advisory.metrics.averageOfferedRate,
              medianOfferedRate: advisory.metrics.medianOfferedRate,
              searches: advisory.metrics.searches,
              lookToBook: advisory.metrics.lookToBook,
              leadTimeBuckets: advisory.metrics.leadTimeBuckets,
              losBuckets: advisory.metrics.losBuckets,
              dayOfWeek: advisory.metrics.dayOfWeek,
            },
            competitive: advisory.competitive,
            partners: advisory.partners,
            findings: advisory.findings.map((f) => ({
              code: f.code,
              lever: f.lever,
              severity: f.severity,
              title: f.title,
              detail: f.detail,
              evidence: f.evidence,
              confidence: f.confidence,
              hasSuggestedCommand: !!f.suggestedCommand,
            })),
          },
          summary: `${advisory.findings.length} finding(s), confidence ${advisory.metrics.confidence}`,
          card: { type: 'revenue', data: advisory },
        };
      }

      case 'get_partner_production': {
        const rows = await clients.search.get<PartnerProduction[]>(
          `/internal/search/partner-production?propertyId=${input.propertyId}&sinceDays=${input.sinceDays ?? 90}`,
          ctx,
        );
        return {
          result: rows,
          summary: `${rows.length} partner(s)`,
          card: { type: 'partners', data: rows },
        };
      }

      case 'diagnose_no_sales': {
        const report = await clients.search.get<DiagnosticReport>(
          `/internal/search/diagnose?propertyId=${input.propertyId}${this.window(input)}`,
          ctx,
        );
        return {
          result: report,
          summary: report.summary,
          card: { type: 'diagnostic', data: report },
        };
      }

      case 'get_availability': {
        const from = input.from ?? toStayDate(new Date());
        const to = input.to ?? addDays(from, 30);
        const rows = await clients.ari.get<any[]>(
          `/internal/ari/effective?propertyId=${input.propertyId}&from=${from}&to=${to}`,
          ctx,
        );
        // The model does not need 900 rows; it needs the shape of them.
        const byDate = new Map<string, { open: number; rooms: number; rates: number[] }>();
        for (const r of rows) {
          const e = byDate.get(r.stayDate) ?? { open: 0, rooms: 0, rates: [] };
          if (r.open) e.open += 1;
          e.rooms += r.available ?? 0;
          if (r.baseAmount != null) e.rates.push(r.baseAmount);
          byDate.set(r.stayDate, e);
        }
        const digest = [...byDate.entries()].map(([stayDate, e]) => ({
          stayDate,
          openCells: e.open,
          roomsOpen: e.rooms,
          averageRate: e.rates.length
            ? Math.round(e.rates.reduce((s, n) => s + n, 0) / e.rates.length)
            : null,
        }));
        return {
          result: { window: { from, to }, cells: rows.length, byDate: digest },
          summary: `${rows.length} cells over ${digest.length} date(s)`,
          card: { type: 'availability', data: { rows, digest } },
        };
      }

      case 'get_ari_health': {
        const from = input.from ?? toStayDate(new Date());
        const to = input.to ?? addDays(from, 30);
        const report = await clients.ari.get<any>(
          `/internal/ari/health-report?propertyId=${input.propertyId}&from=${from}&to=${to}`,
          ctx,
        );
        return {
          result: report,
          summary: `${report.summary?.healthy ?? 0}/${report.summary?.combinations ?? 0} healthy`,
          card: { type: 'ariHealth', data: report },
        };
      }

      case 'get_connectivity_health': {
        const rows = await clients.connectivity.get<any[]>(
          `/internal/connectivity/health${input.propertyId ? `?propertyId=${input.propertyId}` : ''}`,
          ctx,
        );
        return {
          result: rows,
          summary: `${rows.filter((r) => r.issues.length === 0).length}/${rows.length} healthy`,
          card: { type: 'connectivity', data: rows },
        };
      }

      case 'list_promotions': {
        const rows = await clients.coreCommerce.get<PromotionRef[]>(
          `/internal/core/promotions?propertyId=${input.propertyId}`,
          ctx,
        );
        return {
          result: rows,
          summary: `${rows.filter((r) => r.status === 'ACTIVE').length} active of ${rows.length}`,
          card: { type: 'promotions', data: rows },
        };
      }

      case 'list_contracts': {
        const rows = await clients.coreCommerce.get<ContractRef[]>('/internal/core/contracts', ctx);
        return {
          result: rows,
          summary: `${rows.length} contract(s)`,
          card: { type: 'contracts', data: rows },
        };
      }

      case 'get_property_content': {
        const content = await clients.coreCommerce.get<any>(
          `/internal/core/properties/${input.propertyId}/content?locale=${input.locale ?? 'es'}`,
          ctx,
        );
        return {
          result: {
            completeness: content.completeness,
            missing: content.missing,
            values: content.values,
            imageCount: content.images?.length ?? 0,
            withheldImages: content.withheldImages ?? [],
            provenance: content.explanation,
          },
          summary: `${Math.round((content.completeness ?? 0) * 100)}% complete, ${content.images?.length ?? 0} image(s)`,
          card: { type: 'content', data: content },
        };
      }

      case 'get_distribution_reach': {
        const reach = await clients.coreCommerce.get<any>(
          `/internal/core/properties/${input.propertyId}/distribution/reach`,
          ctx,
        );
        const visible = reach.partners.filter((p: any) => p.canSee).length;
        return {
          result: reach,
          summary: `${visible}/${reach.partners.length} partner(s) can see this hotel`,
          card: { type: 'reach', data: reach },
        };
      }

      case 'list_partners': {
        const rows = await clients.coreCommerce.get<any[]>('/internal/core/partners', ctx);
        return {
          result: rows,
          summary: `${rows.length} partner profile(s)`,
          card: { type: 'partnerDirectory', data: rows },
        };
      }

      case 'get_property_demand': {
        const report = await clients.search.get<any>(
          `/internal/search/property-demand?propertyId=${input.propertyId}&days=${input.days ?? 30}`,
          ctx,
        );
        return {
          result: report,
          summary: `${report.impressions} impression(s), ${report.offered} quoted, ${report.bookings} booked`,
          card: { type: 'demand', data: report },
        };
      }

      case 'get_travel_flow': {
        const report = await clients.search.get<any>(
          `/internal/search/travel-flow?direction=${input.direction}&anchor=${input.anchor}&days=${input.days ?? 30}`,
          ctx,
        );
        return {
          result: report,
          summary: `${report.rows.length} route(s), ${report.totalImpressions} impression(s)`,
          card: { type: 'travelFlow', data: report },
        };
      }

      case 'list_group_requests': {
        const qs = new URLSearchParams({ propertyId: input.propertyId });
        if (input.status) qs.set('status', input.status);
        const rows = await clients.groups.get<any[]>(`/internal/groups/requests?${qs}`, ctx);
        const live = rows.filter((r) => r.status === 'OPEN' || r.status === 'COUNTERED');
        return {
          result: rows,
          summary: `${rows.length} request(s), ${live.length} awaiting an answer`,
          card: { type: 'groupRequests', data: rows },
        };
      }

      case 'get_group_policy': {
        const policy = await clients.groups.get<any>(
          `/internal/groups/policy/${input.propertyId}`,
          ctx,
        );
        return {
          result: policy,
          summary: policy.configured
            ? `Floor ${policy.floorRatePerNight ?? 'unset'}, ${policy.benefits.length} benefit rule(s)`
            : 'No group policy configured yet',
          card: { type: 'groupPolicy', data: policy },
        };
      }

      case 'list_event_spaces': {
        const rows = await clients.groups.get<any[]>(
          `/internal/groups/spaces?propertyId=${input.propertyId}`,
          ctx,
        );
        return {
          result: rows,
          summary: `${rows.length} event space(s)`,
          card: { type: 'eventSpaces', data: rows },
        };
      }

      case 'quote_event_space': {
        const quote = await clients.groups.post<any>('/internal/groups/spaces/quote', ctx, {
          spaceId: input.spaceId,
          date: input.date,
          layout: input.layout,
          pax: input.pax,
          hours: input.hours ?? null,
          days: input.days ?? 1,
          addons: input.addons ?? [],
        });
        return {
          result: quote,
          summary: `${quote.total} ${quote.currency} total, ${quote.perPerson} per person`,
          card: { type: 'eventQuote', data: quote },
        };
      }

      default:
        throw new Error(`Unknown tool ${name}`);
    }
  }

  private window(input: any): string {
    const parts: string[] = [];
    if (input?.from) parts.push(`from=${input.from}`);
    if (input?.to) parts.push(`to=${input.to}`);
    return parts.length ? `&${parts.join('&')}` : '';
  }
}
