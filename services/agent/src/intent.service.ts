import { Inject, Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { StructuredCommandSchema, toStayDate } from '@wetriip/contracts';
import { IntentContext, IntentParseResult, parseIntent } from '@wetriip/domain';
import { Logger, M, metrics } from '@wetriip/observability';
import { LOGGER, RequestContext } from '@wetriip/service-kit';

/**
 * Intent extraction.
 *
 * The model's ONLY job is to turn a sentence into a StructuredCommand. It has
 * no tools, no database, no ability to act. Its output is parsed by the same
 * Zod schema the REST API uses, and anything that fails validation is thrown
 * away — a malformed command never reaches the policy engine.
 *
 * Order of attempts, deliberately:
 *   1. the deterministic grammar
 *   2. the LLM, only if the grammar did not match and a key is configured
 *
 * Grammar first is not a cost optimisation. It is that a phrase the grammar
 * recognises must always produce the same command, on every machine, in every
 * test run, forever. The model handles the long tail; the common path is
 * reproducible.
 */
@Injectable()
export class IntentService {
  private readonly anthropic: Anthropic | null;

  constructor(@Inject(LOGGER) private readonly log: Logger) {
    const key = process.env.ANTHROPIC_API_KEY;
    this.anthropic = key ? new Anthropic({ apiKey: key }) : null;
  }

  get llmAvailable(): boolean {
    return this.anthropic != null;
  }

  async extract(
    ctx: RequestContext,
    utterance: string,
    context: IntentContext,
  ): Promise<IntentParseResult & { deterministic: boolean; modelId: string | null }> {
    const grammar = parseIntent(utterance, context);
    if (grammar.matched) {
      return { ...grammar, deterministic: true, modelId: null };
    }

    if (!this.anthropic) {
      // No model configured. We return the grammar's own explanation of what
      // was missing, which is more useful than a generic failure.
      return { ...grammar, deterministic: true, modelId: null };
    }

    const started = Date.now();
    try {
      const modelId = process.env.AGENT_MODEL ?? 'claude-sonnet-5';
      const res = await this.anthropic.messages.create({
        model: modelId,
        max_tokens: 1200,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: JSON.stringify({
              utterance,
              today: toStayDate(context.now),
              screenContext: {
                propertyId: context.propertyId ?? null,
                roomTypeCode: context.roomTypeCode ?? null,
                ratePlanCode: context.ratePlanCode ?? null,
                selectedDates: context.selectedDates ?? null,
                market: context.market ?? null,
              },
              grammarAttempt: { matched: false, reason: grammar.reason },
            }),
          },
        ],
      });
      metrics.observe(M.agentLlmLatency, Date.now() - started, { model: modelId });

      const text = res.content
        .filter((c): c is Anthropic.TextBlock => c.type === 'text')
        .map((c) => c.text)
        .join('');
      const json = extractJson(text);

      if (!json || json.understood === false) {
        return {
          matched: false,
          intent: 'unknown',
          confidence: 0,
          reason: json?.reason ?? grammar.reason,
          deterministic: false,
          modelId,
        };
      }

      // The schema is the airlock. Whatever the model produced, only a valid
      // StructuredCommand gets through.
      const parsed = StructuredCommandSchema.safeParse(json.command);
      if (!parsed.success) {
        this.log.warn('llm produced an invalid command', {
          correlationId: ctx.correlationId,
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        });
        return {
          matched: false,
          intent: json.intent ?? 'unknown',
          confidence: 0,
          reason:
            'I understood the request but could not express it as a permitted action. Rephrase it, or use the form.',
          deterministic: false,
          modelId,
        };
      }

      return {
        matched: true,
        intent: parsed.data.kind,
        confidence: 0.8,
        command: parsed.data,
        deterministic: false,
        modelId,
      };
    } catch (err) {
      this.log.error('llm intent extraction failed', {
        correlationId: ctx.correlationId,
        error: String(err),
      });
      return { ...grammar, deterministic: true, modelId: null };
    }
  }
}

function extractJson(text: string): any | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

const SYSTEM_PROMPT = `You are the intent router of Wetriip Supply OS, a hotel distribution platform.

Your ONLY output is JSON. You do not have tools. You cannot change prices, inventory, contracts or bookings — a separate deterministic system validates, simulates, authorises and executes everything. Your job is to express the user's request as a StructuredCommand, or to say clearly that you cannot.

Reply with exactly one JSON object:
{"understood": true, "intent": "<kind>", "command": { ... }}
or
{"understood": false, "reason": "<what specifically is missing, in the user's language>"}

Permitted command kinds and their shapes:

READ (no confirmation needed)
- explain_no_sales: {kind, propertyId, from?, to?, market?}
- get_availability: {kind, propertyId, from, to, roomTypeCodes?}
- get_ari_health: {kind, propertyId, from?, to?}
- get_connectivity_health: {kind, propertyId?}
- list_promotions: {kind, propertyId}

WRITE (simulated and confirmed by a human before anything happens)
- create_promotion: {kind, code, name, validFrom, validTo, definition:{type, scope:{propertyId, roomTypeCodes?, ratePlanCodes?}, audience:{markets?, organizationIds?, channels?, promoCode?}, bookingWindow:{minAdvanceDays?, maxAdvanceDays?, from?, to?}, stayWindow:{from, to, daysOfWeek?}, los:{min?, max?}, occupancy:{}, discount:{type:"PERCENTAGE"|"FIXED"|"FREE_NIGHTS", value, currency?, stayNights?, payNights?}, stacking:{allowed, priority}}}
- update_rates: {kind, target:{propertyId, roomTypeCodes?, ratePlanCodes?, from, to, daysOfWeek?, occupancy?}, changeType:"PERCENTAGE"|"ABSOLUTE"|"SET", value, currency?, reason?}
- update_availability: {kind, target:{...}, changeType:"SET"|"DELTA", value, reason?}
- update_restriction: {kind, target:{...}, restriction:{open?, closedToArrival?, closedToDeparture?, minLos?, maxLos?, releaseDays?}, reason?}
- rollback_action: {kind, actionId, reason?}

Rules you must not break:
- All dates are ISO yyyy-mm-dd. Resolve relative dates against the supplied "today".
- Markets are ISO-3166 alpha-2 uppercase.
- NEVER invent a propertyId. If screenContext has none and the user did not name one, return understood:false.
- NEVER guess a date range, a discount or an amount that the user did not state. Missing information means understood:false with a specific question.
- A decrease is a negative value on update_rates; an increase is positive.
- If the request is outside these kinds, return understood:false and say what the platform can do instead.`;
