import { z } from 'zod';
import {
  EventSpaceAddonSchema,
  EventSpaceRateSchema,
  LayoutCapacitySchema,
} from './eventspace';
import { GroupBenefitSchema } from './groups';
import { ISO_DATE } from './ids';
import { PromotionDefinitionSchema } from './promotion';

/**
 * ═══════════════════════════════════════════════════════════════════
 *  THE ARCHITECTURAL INVARIANT OF THIS PLATFORM
 *
 *  The LLM never modifies inventory, price, contracts or bookings.
 *
 *  An LLM's only output is a StructuredCommand: a Zod-validated value in
 *  the closed union below. Anything it cannot express here, it cannot do.
 *  From that point on the path is entirely deterministic —
 *  policy -> simulation -> confirmation -> execution -> audit — and is
 *  identical whether the command came from a model, the deterministic
 *  grammar parser, a REST client or a button in the console.
 *
 *  This is what stops a misread sentence from becoming 1,000 rooms at USD 1.
 * ═══════════════════════════════════════════════════════════════════
 */

export const AGENT_NAMES = [
  'SupplyOrchestrator',
  'PropertyAgent',
  'ConnectivityAgent',
  'RevenueAgent',
  'PromotionAgent',
  'ContractAgent',
  'DistributionAgent',
  'BookingAgent',
  'DiagnosticAgent',
] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

/** Level 1 Observe · Level 2 Recommend · Level 3 Execute. */
export type AutonomyLevel = 1 | 2 | 3;
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

const dateStr = z.string().regex(ISO_DATE);

const TargetSchema = z
  .object({
    propertyId: z.string().min(1),
    roomTypeCodes: z.array(z.string()).nullish(),
    ratePlanCodes: z.array(z.string()).nullish(),
    from: dateStr,
    to: dateStr,
    daysOfWeek: z.array(z.number().int().min(0).max(6)).nullish(),
    occupancy: z.number().int().min(1).max(12).nullish(),
  })
  .strict();

// ── READ COMMANDS (autonomy level 1 — no confirmation) ──────────────

const ExplainNoSales = z
  .object({
    kind: z.literal('explain_no_sales'),
    propertyId: z.string().min(1),
    from: dateStr.nullish(),
    to: dateStr.nullish(),
    market: z.string().length(2).nullish(),
  })
  .strict();

const GetAvailability = z
  .object({
    kind: z.literal('get_availability'),
    propertyId: z.string().min(1),
    from: dateStr,
    to: dateStr,
    roomTypeCodes: z.array(z.string()).nullish(),
  })
  .strict();

const GetAriHealth = z
  .object({
    kind: z.literal('get_ari_health'),
    propertyId: z.string().min(1),
    from: dateStr.nullish(),
    to: dateStr.nullish(),
  })
  .strict();

const GetConnectivityHealth = z
  .object({ kind: z.literal('get_connectivity_health'), propertyId: z.string().nullish() })
  .strict();

const ListPromotions = z
  .object({ kind: z.literal('list_promotions'), propertyId: z.string().min(1) })
  .strict();

const GetRevenueAdvisory = z
  .object({
    kind: z.literal('get_revenue_advisory'),
    propertyId: z.string().min(1),
    from: dateStr.nullish(),
    to: dateStr.nullish(),
  })
  .strict();

const GetPartnerProduction = z
  .object({
    kind: z.literal('get_partner_production'),
    propertyId: z.string().min(1),
    sinceDays: z.number().int().min(1).max(730).nullish(),
  })
  .strict();

// ── WRITE COMMANDS (simulated, then confirmed, then executed) ───────

const CreatePromotion = z
  .object({
    kind: z.literal('create_promotion'),
    code: z.string().min(2).max(40),
    name: z.string().min(2).max(120),
    definition: PromotionDefinitionSchema,
    validFrom: dateStr,
    validTo: dateStr,
  })
  .strict();

const UpdateRates = z
  .object({
    kind: z.literal('update_rates'),
    target: TargetSchema,
    /** Exactly one of the two. A percentage and an absolute amount in the same
     *  command is an ambiguity we refuse rather than resolve. */
    changeType: z.enum(['PERCENTAGE', 'ABSOLUTE', 'SET']),
    value: z.number(),
    currency: z.string().length(3).nullish(),
    reason: z.string().max(500).nullish(),
  })
  .strict();

const UpdateAvailability = z
  .object({
    kind: z.literal('update_availability'),
    target: TargetSchema,
    changeType: z.enum(['SET', 'DELTA']),
    value: z.number().int(),
    reason: z.string().max(500).nullish(),
  })
  .strict();

const UpdateRestriction = z
  .object({
    kind: z.literal('update_restriction'),
    target: TargetSchema,
    restriction: z
      .object({
        open: z.boolean().nullish(),
        closedToArrival: z.boolean().nullish(),
        closedToDeparture: z.boolean().nullish(),
        minLos: z.number().int().min(1).max(365).nullish(),
        maxLos: z.number().int().min(1).max(365).nullish(),
        releaseDays: z.number().int().min(0).max(365).nullish(),
      })
      .strict(),
    reason: z.string().max(500).nullish(),
  })
  .strict();

/**
 * Modify a live promotion. A separate command from create on purpose: the
 * blast radius, the risk and the inverse are all different, and "change the
 * Mexico promo to 12%" must not be able to accidentally create a second one.
 */
const UpdatePromotion = z
  .object({
    kind: z.literal('update_promotion'),
    promotionId: z.string().min(1),
    /** Only the fields being changed. Everything else is carried forward from
     *  the current version, so a partial edit cannot silently clear a rule. */
    changes: z
      .object({
        name: z.string().min(2).max(120).nullish(),
        discountValue: z.number().nonnegative().nullish(),
        markets: z.array(z.string().length(2)).nullish(),
        organizationIds: z.array(z.string()).nullish(),
        channels: z.array(z.enum(['B2B', 'B2C', 'MOBILE', 'CORPORATE'])).nullish(),
        stayFrom: dateStr.nullish(),
        stayTo: dateStr.nullish(),
        daysOfWeek: z.array(z.number().int().min(0).max(6)).nullish(),
        minAdvanceDays: z.number().int().min(0).max(730).nullish(),
        minLos: z.number().int().min(1).max(365).nullish(),
        maxLos: z.number().int().min(1).max(365).nullish(),
        roomTypeCodes: z.array(z.string()).nullish(),
        ratePlanCodes: z.array(z.string()).nullish(),
        stackable: z.boolean().nullish(),
        priority: z.number().int().nullish(),
      })
      .strict(),
    reason: z.string().max(500).nullish(),
  })
  .strict();

const SetPromotionStatus = z
  .object({
    kind: z.literal('set_promotion_status'),
    promotionId: z.string().min(1),
    status: z.enum(['ACTIVE', 'PAUSED', 'CANCELLED']),
    reason: z.string().max(500).nullish(),
  })
  .strict();

const RollbackAction = z
  .object({
    kind: z.literal('rollback_action'),
    actionId: z.string().min(1),
    reason: z.string().max(500).nullish(),
  })
  .strict();


/* ── Groups and event space ───────────────────────────────
 *
 * Loading a salón is the clearest case for dictation the platform has: a sales
 * manager reciting capacities and prices is faster by voice than by form. The
 * command is still a typed structure — the model transcribes intent into it and
 * never touches the table itself.
 */

const ListGroupRequests = z
  .object({
    kind: z.literal('list_group_requests'),
    propertyId: z.string().min(1),
    status: z
      .enum(['OPEN', 'COUNTERED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN'])
      .nullish(),
  })
  .strict();

const GetEventSpaces = z
  .object({
    kind: z.literal('get_event_spaces'),
    propertyId: z.string().min(1),
  })
  .strict();

const SetGroupPolicy = z
  .object({
    kind: z.literal('set_group_policy'),
    propertyId: z.string().min(1),
    minRoomsForGroup: z.number().int().min(2).max(500).nullish(),
    floorRatePerNight: z.number().nonnegative().nullish(),
    floorCurrency: z.string().length(3).nullish(),
    responseWindowHours: z.number().int().min(1).max(168).nullish(),
    depositPct: z.number().min(0).max(100).nullish(),
    /** "Una gratuidad por cada 20 habitaciones" lands here. */
    benefits: z.array(GroupBenefitSchema).max(20).nullish(),
    reason: z.string().max(500).nullish(),
  })
  .strict();

const UpsertEventSpace = z
  .object({
    kind: z.literal('upsert_event_space'),
    propertyId: z.string().min(1),
    code: z.string().min(2).max(40),
    name: z.string().min(2).max(160),
    currency: z.string().length(3),
    layouts: z.array(LayoutCapacitySchema).min(1),
    rates: z.array(EventSpaceRateSchema).min(1),
    addons: z.array(EventSpaceAddonSchema).max(40).nullish(),
    areaM2: z.number().positive().nullish(),
    reason: z.string().max(500).nullish(),
  })
  .strict();

/**
 * Answering an agency's offer commits the hotel to a price. It is the only
 * command here that moves money, which is why it is always HIGH risk and always
 * asks for step-up — the model may draft the answer, never send it.
 */
const RespondGroupRequest = z
  .object({
    kind: z.literal('respond_group_request'),
    requestId: z.string().min(1),
    decision: z.enum(['ACCEPT', 'COUNTER', 'DECLINE']),
    counterTotal: z.number().positive().nullish(),
    message: z.string().max(2000).nullish(),
  })
  .strict();

export const StructuredCommandSchema = z.discriminatedUnion('kind', [
  ExplainNoSales,
  GetAvailability,
  GetAriHealth,
  GetConnectivityHealth,
  ListPromotions,
  GetRevenueAdvisory,
  GetPartnerProduction,
  CreatePromotion,
  UpdatePromotion,
  SetPromotionStatus,
  UpdateRates,
  UpdateAvailability,
  UpdateRestriction,
  ListGroupRequests,
  GetEventSpaces,
  SetGroupPolicy,
  UpsertEventSpace,
  RespondGroupRequest,
  RollbackAction,
]);
export type StructuredCommand = z.infer<typeof StructuredCommandSchema>;
export type CommandKind = StructuredCommand['kind'];

export const READ_COMMANDS: CommandKind[] = [
  'explain_no_sales',
  'get_availability',
  'get_ari_health',
  'get_connectivity_health',
  'list_promotions',
  'get_revenue_advisory',
  'get_partner_production',
  'list_group_requests',
  'get_event_spaces',
];

export function isReadCommand(kind: CommandKind): boolean {
  return READ_COMMANDS.includes(kind);
}

/**
 * Operations that always require step-up authentication regardless of the
 * user's autonomy level or how confident the model was.
 */
export const ALWAYS_HIGH_RISK: CommandKind[] = ['rollback_action', 'respond_group_request'];

export type AgentActionStatus =
  | 'PROPOSED'
  | 'AWAITING_CONFIRMATION'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXECUTING'
  | 'EXECUTED'
  | 'FAILED'
  | 'ROLLED_BACK';

export interface PolicyDecision {
  allowed: boolean;
  requiresConfirmation: boolean;
  requiresStepUp: boolean;
  autonomyLevel: AutonomyLevel;
  riskLevel: RiskLevel;
  checks: Array<{
    code: string;
    label: string;
    passed: boolean;
    detail?: string;
    limit?: number | string;
    actual?: number | string;
  }>;
  denialReason?: string;
}

/** The diff a human sees before saying yes. Counts first, then samples —
 *  "280 ARI cells" is the number that stops a bad command, not the prose. */
export interface SimulationResult {
  feasible: boolean;
  blastRadius: {
    properties: number;
    roomTypes: number;
    ratePlans: number;
    stayDates: number;
    ariCells: number;
  };
  diffs: Array<{
    scope: string;
    field: string;
    before: unknown;
    after: unknown;
    count: number;
  }>;
  samples: Array<{
    stayDate: string;
    roomTypeCode: string;
    ratePlanCode: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  }>;
  projections: {
    avgBefore: number | null;
    avgAfter: number | null;
    minAfter: number | null;
    maxAfter: number | null;
    adrDeltaPct: number | null;
    estimatedRevenueImpact: number | null;
    currency: string | null;
  };
  warnings: string[];
  blockers: string[];
  /** Human-readable confirmation sentence, generated deterministically from
   *  the numbers above — not written by the model. */
  confirmationPrompt: string;
}

export interface AgentActionView {
  id: string;
  sessionId: string;
  agent: AgentName | string;
  intent: string;
  utterance: string;
  command: StructuredCommand;
  status: AgentActionStatus;
  autonomyLevel: number;
  riskLevel: RiskLevel;
  requiresStepUp: boolean;
  deterministicIntent: boolean;
  modelId: string | null;
  policyDecision: PolicyDecision | null;
  simulation: SimulationResult | null;
  result: unknown;
  error: string | null;
  correlationId: string;
  createdAt: string;
  executedAt: string | null;
  rollbackOfId: string | null;
  rolledBackById: string | null;
}

export const AgentAskSchema = z
  .object({
    utterance: z.string().min(1).max(2000),
    channel: z.enum(['VOICE', 'CHAT', 'API']).default('CHAT'),
    sessionId: z.string().nullish(),
    /** Screen context. This is what makes "put a 3-night minimum here" work
     *  without repeating property, room, rate plan and dates. */
    context: z
      .object({
        propertyId: z.string().nullish(),
        roomTypeCode: z.string().nullish(),
        ratePlanCode: z.string().nullish(),
        selectedDates: z.array(dateStr).nullish(),
        market: z.string().length(2).nullish(),
      })
      .nullish(),
  })
  .strict();
export type AgentAskInput = z.infer<typeof AgentAskSchema>;

export interface AgentAskResponse {
  action: AgentActionView;
  /** What to say back. For read commands this carries the answer; for write
   *  commands it is the confirmation request. */
  speech: string;
  data?: unknown;
  requiresConfirmation: boolean;
}


/* ═══════════════════════════════════════════════════════════════════
 * CONVERSATION
 *
 * The AI Command Center is a real assistant, not a command bar. It holds a
 * thread, reads freely to ground what it says, and answers in prose.
 *
 * The invariant is unchanged and is enforced by the tool split:
 *   READ tools execute immediately — they change nothing.
 *   The single WRITE tool, `propose_change`, cannot execute anything. It
 *   validates a StructuredCommand, simulates it, evaluates policy and returns
 *   a PROPOSAL. A human confirms it in the UI, on the same path a typed
 *   command takes.
 *
 * So the model can be as fluent as it likes about revenue strategy, and still
 * cannot move a single rate on its own.
 * ═══════════════════════════════════════════════════════════════════ */

export const ConversationRoleSchema = z.enum(['user', 'assistant']);
export type ConversationRole = z.infer<typeof ConversationRoleSchema>;

/** One transparent step in the assistant's reasoning: which tool it reached
 *  for, and what came back. Shown in the UI rather than hidden. */
export interface ToolStep {
  id: string;
  name: string;
  label: string;
  input: Record<string, unknown>;
  status: 'RUNNING' | 'OK' | 'ERROR';
  summary?: string;
  error?: string;
  durationMs?: number;
  /** Structured payload the UI can render as a card instead of prose. */
  card?: { type: string; data: unknown } | null;
}

export interface ConversationMessage {
  id: string;
  sessionId: string;
  role: ConversationRole;
  content: string;
  steps: ToolStep[];
  /** Proposals raised during this turn, awaiting confirmation. */
  proposals: AgentActionView[];
  createdAt: string;
  modelId: string | null;
  deterministic: boolean;
}

export const ChatRequestSchema = z
  .object({
    message: z.string().min(1).max(4000),
    sessionId: z.string().nullish(),
    channel: z.enum(['VOICE', 'CHAT', 'API']).default('CHAT'),
    context: z
      .object({
        propertyId: z.string().nullish(),
        roomTypeCode: z.string().nullish(),
        ratePlanCode: z.string().nullish(),
        selectedDates: z.array(dateStr).nullish(),
        market: z.string().length(2).nullish(),
      })
      .nullish(),
  })
  .strict();
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/** Server-sent event names on POST /agent/chat/stream. */
export type ChatStreamEvent =
  | { type: 'session'; sessionId: string; messageId: string }
  | { type: 'step'; step: ToolStep }
  | { type: 'text'; delta: string }
  | { type: 'proposal'; action: AgentActionView }
  | { type: 'done'; message: ConversationMessage }
  | { type: 'error'; code: string; message: string; remediation?: string };
