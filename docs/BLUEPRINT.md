# Wetriip Supply OS — CTO Technical Blueprint v1.0

Status: implemented and running. Every section below describes code in this
repository, not a proposal. Where something is deliberately not built yet it is
marked **[NOT BUILT]** with the reason.

Derived from the HyperGuest master audit (24 July 2026) and the Wetriip Brand
Manual v1.0.

---

## 0. The decision that shapes everything else

> **The LLM never modifies inventory, price, contracts or bookings.**
>
> It understands intent. A deterministic system validates, simulates,
> authorises and executes.

Concretely: a model's only permitted output is a value in the closed union
`StructuredCommandSchema` (`packages/contracts/src/agent.ts`). Nineteen command
kinds exist; nine read, ten write. Anything outside that union cannot be expressed,
so it cannot happen.

Everything after intent extraction is deterministic and identical regardless of
where the command came from:

```
utterance ─► intent ─► StructuredCommand ─► simulation ─► policy
                              │                              │
                              │                    ┌─────────┴─────────┐
                              │                  allowed            denied
                              │                    │                  │
                              │              confirmation          audit
                              │                    │
                              │              execution (MANAGED layer only)
                              │                    │
                              │              verification + audit
                              ▼                    ▼
                        rejected + audit      rollback available
```

Simulation runs **before** policy on purpose: half the limits (blast radius,
floor rate, resulting ADR) are only knowable once the diff is computed. A policy
engine that runs first can only check what the user typed — which is exactly the
set of things a mistaken command gets wrong.

---

## 1. C4 — Context

```
┌──────────────────────────────────────────────────────────────────────┐
│                          WETRIIP ECOSYSTEM                            │
│                                                                       │
│  Wetriip AI  ──"Organise Cartagena for 20 people"──► Unified Graph    │
│       │                                                    │          │
│       └────────────────── HotelOffer[] ◄───────────────────┘          │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
              ┌─────────────────▼──────────────────┐
              │      WETRIIP SUPPLY OS             │
              │      (this system)                 │
              └──┬──────────┬──────────┬───────────┘
                 │          │          │
   Hotel staff ──┘          │          └── Buyers: agencies, wholesalers,
   (voice, console)         │              OTAs, corporates
                            │
              Channel managers / PMS / switches
              SiteMinder · Dingus · Cloudbeds · DerbySoft · canonical JSON
```

Supply OS owns the hotel side of the graph: what exists, how much is left, what
it costs, who may buy it, and whether a booking succeeded. Transfers and
activities are sibling systems behind the same graph.

---

## 2. C4 — Containers

| Container | Port | Owns | Scaling driver | Failure it must survive alone |
|---|---|---|---|---|
| `gateway` | 3100 | AuthN, BFF composition, console | request fan-out | none (stateless) |
| `core-commerce` | 3110 | Property, rooms, rate plans, taxes, contracts, promotions | low, transactional | none |
| `connectivity` | 3120 | Adapters, webhooks, pull jobs, mapping versions | provider count × property count | a provider being down, slow or rate-limiting |
| `ari-ingestion` | 3130 | Ledger, layer cells, Effective ARI, health | write throughput, bursty | a burst of full syncs |
| `search` | 3140 | Sellability, pricing, offers, diagnostics | read QPS, p95 800 ms | a cold cache |
| `booking` | 3150 | Saga, idempotency, supplier calls | low volume, highest criticality | a supplier timeout |
| `agent` | 3160 | Intent, policy, simulation, execution, rollback | LLM latency and cost | the model being unavailable |
| `reconciliation` | 3170 | Divergence detection | batch, off-peak | being slow |
| `groups` | 3180 | Group blocks, benefits, negotiation, notifications, event space | low volume, long-lived, deadline-driven | a stuck negotiation, which must never slow a search |

**Data ownership.** One Postgres instance in stage 1, with strict table
ownership: a service reads and writes only its own aggregate and reaches other
domains through APIs and events, never through a join. That constraint is what
makes the later split into separate databases a configuration change instead of
a rewrite. The ownership map is documented in `packages/persistence/src/index.ts`
and enforced at review.

**Communication.** Async facts travel on the event bus (transactional outbox →
relay; Kafka/Redpanda slots in behind the same interface). Synchronous reads use
typed clients from `@wetriip/service-kit`, which preserve the error code and
correlation id across the hop — a `POLICY_DENIED` raised in `agent` still reads
as `POLICY_DENIED` at the gateway instead of degrading into a 500.

---

## 3. C4 — Components (the engines)

All in `packages/domain`. Pure functions, no I/O, 175 unit tests.

| Engine | File | Responsibility |
|---|---|---|
| Ordering | `ordering.ts` | APPLY / DUPLICATE / OUT_OF_ORDER per cell |
| Effective ARI | `effective-ari.ts` | External + Managed → Effective, field-by-field provenance |
| Sellability | `sellability.ts` | Nine predicates, each with evidence, owner, remediation |
| Promotions | `promotions.ts` | DSL eligibility + discount + stacking order |
| Pricing | `pricing.ts` | The fixed money pipeline |
| FX | `fx.ts` | Supplier / normalized / buyer amounts, never collapsed |
| Offer integrity | `offer-signature.ts` | HMAC + TTL |
| Policy | `policy.ts` | RBAC × autonomy × numeric limits |
| Simulation | `simulation.ts` | Blast radius, diff, confirmation sentence |
| Intent grammar | `intent-grammar.ts` | ES/EN → StructuredCommand, deterministically |
| Diagnostics | `diagnostics.ts` | The "why am I not selling?" funnel |
| Revenue | `revenue.ts` | Occupancy/ADR/RevPAR, pace, partner net value, advisory findings |
| Content | `content.ts` | Layered profile merge, completeness, image licensing gate |
| Distribution | `distribution.ts` | Marketplace/geo/partner eligibility, credit decision |
| Demand | `demand.ts` | Impressions per buyer, outbound and inbound travel flow |
| Groups | `groups.ts` | Block capacity under two constraints, comp-room arithmetic, bid evaluation against the floor, the 24-hour clock |
| Event space | `eventspace.ts` | Layout capacity gate, cheapest applicable rate unit, the SPACE→SETUP→EQUIPMENT→CATERING→TAX pipeline |
| Resilience | `resilience.ts` | Token bucket, circuit breaker, bulkhead, backoff |

---

## 4. ARI — the canonical model

### 4.1 Cell key

```
tenant / property / room_type / rate_plan / stay_date / occupancy / layer
```

Partition key for ordered processing is `property:room:rate` — ordering is
guaranteed within a partition, and different rooms process in parallel.

### 4.2 Layers

| Layer | Origin | Rule |
|---|---|---|
| **EXTERNAL** | Channel manager / supplier | Immutable per event. Never overwritten by a human. |
| **MANAGED** | User or agent | Coexists with External. Requires actor, reason, validity window. |
| **Contractual** | Contract / promotion | Applied when building an offer — **never written into the ledger** |
| **Effective** | Computed | Deterministic projection of External + Managed |

A managed override wins **field by field**, and only while its validity window
covers the stay date. When it expires the external value re-emerges on its own —
no cleanup job, no drift.

Freshness is measured against the **external** layer only. A human override must
never make a dead channel-manager feed look alive.

### 4.3 The ledger

`AriEvent` is append-only. Rows are written once, with their processing outcome
already decided, and are never updated. Rejected and out-of-order events are
**still written** — evidence of what a partner sent is exactly what you need at
2am, and dropping it is how "the channel manager swears they sent it" becomes
unanswerable.

Every row carries: `before`, `after`, `sourceTimestamp`, `receivedAt`,
`processedAt`, `payloadHash`, `idempotencyKey` (unique), `correlationId`,
`mappingVersion`, `sourceSequence`, `actorType`, `status`, `rejectReason`.

### 4.4 Idempotency and ordering

Two independent controls:

1. **`idempotencyKey`** = `sha256(source | cellKey | layer | sourceTimestamp | payloadHash)`,
   with a unique constraint. A redelivery loses the insert.
2. **Content hash on the cell.** `AriCell.lastPayloadHash` holds the hash of the
   cell's *resulting state*. A republished full snapshot with a fresh timestamp
   and unchanged content is recognised as a no-op. Channel managers resend
   constantly; without this, every resend would bump a version and emit a
   spurious change event.

Ordering prefers a provider sequence when both sides have one, falls back to
`sourceTimestamp`, and on an exact tie with differing content applies and flags —
silently discarding a real change is worse than a recorded ambiguity.

---

## 4a. Property content

Same layering as ARI, same reason.

| Layer | Origin | Rule |
|---|---|---|
| `EXTERNAL` | Content source | Never overwrites the hotel's own text |
| `MANAGED` | The hotel | Wins field by field |
| Effective | Computed | Per-field provenance, completeness score, missing list |

An imported empty string or empty array is treated as "not mentioned", never as
"clear this". Completeness is **weighted**: a hotel with no photos is not 90%
complete because it filled in a phone number, and images carry the single
largest weight.

**Image licensing is a gate, not metadata.** An `EXTERNAL` image without a
credit and a licence is withheld from publication and reported as withheld.

Content sources use the channel-manager pattern: declared capabilities, honest
certification state, and `NOT_IMPLEMENTED` with the outstanding requirements
until the agreement exists. `redistributionPermitted` is a legal fact recorded
alongside the technical ones, because it decides whether the integration may
exist at all.

## 4b. Distribution policy

Evaluated **before** contracts and **before** pricing.

```
CLOSED / SELECTED_PARTNERS / MARKETPLACE_OPEN
  + market allow & deny        + partner type
  + partner allow & deny       + channel
  + booking window             + minimum stay
  + rate floor (overrides any contract)
```

Ordering rules that matter:

- A **blocklist beats an allow list**. A hotel that explicitly blocked a partner
  must not be let back in by any other rule.
- An **empty allow list under SELECTED_PARTNERS is refused at validation** —
  it would hide the hotel from everyone, and `CLOSED` is the honest way to say
  that.
- A floor in a currency that cannot be compared to the offer is **not enforced,
  and says so**, rather than silently passing or silently blocking.
- Every organization id on either list is validated against the tenant. A typo
  here silently hides a hotel, and the hotel cannot tell that from a bug.

## 4c. Partners and credit

`partnerCode` is an external identifier: quoted on bookings and invoices, and
**immutable once issued** — changing it breaks reconciliation upstream of us.

Tax identity stores the **scheme** alongside the number (NIT, RFC, CUIT, RUC,
CNPJ, VAT, EIN…). Storing both as `taxId: string` is how an invoice gets
rejected by a tax authority.

Credit is an append-only ledger. `creditUsed` is its running total and moves
only by writing an entry; each entry records `balanceAfter` so any row is
independently auditable. `HOLD`/`CHARGE` increase exposure, `RELEASE`/`PAYMENT`
reduce it.

The decision runs before the supplier call. A hold is placed only on a
**confirmed** booking — holding against `UNKNOWN` would freeze credit for a
reservation that may not exist — and released only on a **confirmed**
cancellation.

## 4d. Demand intelligence

`SearchImpression`: one row per property per search, with buyer, source market,
destination, and the failing predicates when no offer was produced.

| Read | Question it answers |
|---|---|
| Property demand | Who looked at me, how often, what stopped us quoting, did they buy |
| Outbound (emisivo) | Where are buyers from this market searching |
| Inbound (receptivo) | Who is looking at this destination, rising or falling |

Sample-size gates throughout: confidence grades on every report, and a trend
only computed against a prior window with at least ten observations. The basis
line states this is platform-observed demand, not a national statistic.

---

## 5. Sellability

```
SELLABLE = property_approved ∧ mapping_active ∧ ari_fresh
         ∧ availability > 0 ∧ property_open ∧ restrictions_satisfied
         ∧ price_valid ∧ contract_active ∧ buyer_eligible
```

Two design choices matter more than the formula:

1. **Every predicate runs.** No short-circuit. "The first reason it failed" is a
   worse answer than "all four reasons" when a revenue manager is trying to fix
   their hotel.
2. **A predicate that could not be evaluated reports `evaluated: false`** instead
   of quietly passing. Missing input is not a green light.

Each result carries evidence, an owner (`Connectivity`, `Catalog`, `Commercial`,
`Supplier`, `Pricing`, `Distribution`), a remediation and whether the platform
can fix it itself.

Search responses include `excluded[]` with the failing predicates — the
difference between telling a hotel "no results" and telling them "your BAR plan
is closed to arrival on the dates they searched".

---

## 6. Pricing pipeline

Fixed order, every step recorded with input, output, delta and cause:

```
BASE → OCCUPANCY → PROMOTION → CONTRACT_MARKUP → CONTRACT_COMMISSION
     → TAX → FEE → FX → ROUNDING
```

The order is not cosmetic. Applying commission before promotions, or tax before
discount, produces a different invoice. It is fixed once so that search,
re-validation at booking time and reconciliation can never disagree.

**Currency provenance is never destroyed.** Every offer and booking carries
supplier / normalized / buyer amounts plus the rate, its source and its
timestamp. Collapsing to USD on ingest is the cheapest way to make reconciliation
impossible: FX moves, the hotel invoices in COP, the agency pays in MXN, and
nobody can reproduce the quoted number.

Commission is recorded as a **zero-delta step**: it changes who keeps the money,
not what the buyer pays.

---

## 7. Promotion DSL

Promotions are data, not code paths. A new type must be expressible in
`PromotionDefinitionSchema` or it does not exist.

```yaml
type: EARLY_BOOKING
scope:        { propertyId, roomTypeCodes?, ratePlanCodes? }
audience:     { markets?, organizationIds?, channels?, closedUserGroup?, promoCode? }
bookingWindow:{ minAdvanceDays?, maxAdvanceDays?, from?, to? }
stayWindow:   { from, to, daysOfWeek? }
los:          { min?, max? }
occupancy:    { minAdults?, maxAdults? }
discount:     { type: PERCENTAGE|FIXED|FREE_NIGHTS, value, currency?, stayNights?, payNights? }
stacking:     { allowed, priority }
```

Eighteen types are expressible today, including STAY_X_PAY_Y, GEO,
AGENCY_EXCLUSIVE, CLOSED_USER_GROUP and PROMO_CODE.

**Selection order**, documented because it decides money:

1. keep only eligible promotions
2. sort by priority ascending, then discount descending
3. apply the first
4. keep applying only while every promotion applied so far **and** the next one
   are both stackable

The stay window is applied **per night**: a 5-night stay overlapping a promotion
for 2 nights gets the discount on those 2 nights — not on the whole booking, and
not on nothing.

---

## 8. Connectivity — the plane built for many APIs

### 8.1 Adapter contract

One interface (`ChannelManagerAdapter`), twelve operations. Adding a provider is
one class plus fixtures. An adapter may only: translate payloads to canonical
events, translate canonical commands to its payloads, and declare its
capabilities and rate limits honestly.

It may never: touch the database, know what a promotion is, decide sellability,
or log a credential.

### 8.2 Capabilities are per operation

Never a generic "push/pull" label. The audit flagged that label as a source of
support and design errors: a provider can push rates but only accept pulled
restrictions. `monotonicSequence` and `signatureScheme` are declared explicitly —
if a provider offers no sequence, ordering is best-effort and we say so.

### 8.3 Resilience, scoped per connection

Every outbound call goes through `ConnectionRuntime`. Nothing calls a partner API
directly.

```
circuit breaker → bulkhead → token bucket → call → retry with full jitter
```

State is per **connection**, not per provider: 400 hotels on one channel manager
are 400 independent budgets, so one hotel's misconfiguration cannot starve the
rest. A 4xx is never retried — retrying burns their rate limit and hides the real
error.

### 8.4 Two Push/Pull axes, deliberately separate

| Plane | Push | Pull |
|---|---|---|
| **Source** (CM ↔ platform) | provider posts to our webhook | our scheduler fetches with a checkpoint |
| **Demand** (platform ↔ buyer) | we publish deltas to a subscription **[NOT BUILT]** | buyer calls `/search` |

They live in different services and share no code. Conflating them is the design
error the audit named.

### 8.5 Inbound flow

Raw envelope is persisted **before** interpretation, hashed, with the signature
verdict. If parsing then fails we still hold exactly what they sent and can
replay once the mapping or adapter is fixed. Losing the payload and keeping only
the error is how integrations become unfalsifiable.

### 8.6 Certification gate

`runConformance(adapter)` checks declared-vs-real capabilities, canonical output
shape, date expansion, EXTERNAL-layer discipline, provenance completeness,
mapping enforcement, pull window adherence, and that health output leaks no
credential. A connection should not be enabled until the report says
`certified: true`.

The four named channel managers are registered as **uncertified**: every
operation fails with `NOT_IMPLEMENTED` plus the outstanding checklist, and health
reports `ok: false`.

---

## 9. Booking saga

```
DRAFT ─► PENDING ─┬─► CONFIRMED ─► CANCEL_PENDING ─► CANCELLED
                  ├─► REJECTED
                  └─► UNKNOWN ─┬─► CONFIRMED
                               ├─► REJECTED
                               └─► MANUAL_REVIEW
```

`UNKNOWN` is a real state, not an error path. A supplier timeout does not mean
the supplier did nothing — it means we do not know yet. Collapsing it into
`FAILED` and retrying is how platforms double-book.

Sequence:

1. Check for an existing booking on this `idempotencyKey` → return it if found
2. Claim the key in a durable store **before** any external effect
3. Revalidate the offer: signature, TTL, **and a live ARI re-read** — three
   separate questions, deliberately not collapsed
4. Persist `PENDING` **before** calling the supplier, so a process crash leaves a
   row reconciliation can find
5. Call the supplier with the idempotency key passed through
6. Transition through the state machine; illegal transitions throw
7. Complete the key. It is never released after a possible external effect

Price drift between offer and booking is recorded, not blocking — we honour the
signed price and let reconciliation see the movement.

---

## 10. Agent Control Plane

### 10.1 Agents

`SupplyOrchestrator` routes to `PropertyAgent`, `ConnectivityAgent`,
`RevenueAgent`, `PromotionAgent`, `ContractAgent`, `DistributionAgent`,
`BookingAgent`, `DiagnosticAgent`. The agent name is recorded on every action.

### 10.2 Three levels of autonomy

| Level | Name | Behaviour |
|---|---|---|
| 1 | Observe | Reads and explains. Writes are refused outright. |
| 2 | Recommend | May propose any permitted write; a human confirms. |
| 3 | Execute | May execute LOW/MEDIUM risk without asking. HIGH still stops. |

Effective autonomy = `min(user.maxAutonomy, AGENT_MAX_AUTONOMY)`.

**The agent can never exceed the invoking user.** An agent invoked by a
reservation agent cannot do what a revenue manager could — it inherits the
caller's permissions, it does not carry its own.

### 10.3 Always high-risk

Rate movement beyond the tenant limit; discount beyond the tenant limit; blast
radius beyond the tenant limit; closing inventory (`open: false`); setting
availability to zero; rollback. These require step-up authentication regardless
of level or model confidence.

### 10.4 Simulation output

Counts first, then samples — "280 ARI cells" is the number that stops a bad
command, not the prose. The confirmation sentence is generated from the computed
diff. **The model never describes its own change**; a model that hallucinated
"this affects 12 dates" when it affects 2,800 would defeat the approval step.

A revenue projection is only produced when a demand signal was supplied.
An invented number is worse than no number: people act on it.

### 10.5 Natural-language undo

Nothing is deleted and no state is restored from backup. The inverse command is
computed from what the action recorded and applied as a **new** managed override,
so the undo is itself versioned, auditable and undoable.

Reversal uses `SET`, not the opposite delta: reversing +10% with −10% does not
return to the original number.

### 10.6 Conversational surface

The Command Center is a thread, not a command line. The safety model survives
that because of where the boundary sits:

```
user turn
  └─► model (tools: 10 read + 1 write)
        ├─ read tool  ──► executes immediately, returns data + a UI card
        └─ propose_change ──► Zod validate ─► simulate ─► policy
                                  └─► PROPOSAL, awaiting a human
```

`propose_change` has no execution path at all. A validation failure returns the
exact Zod issues to the model so it can correct itself once — more reliable than
a rigid JSON schema whose errors it never sees. A policy denial returns the
failed checks and an instruction not to retry.

The tool loop is bounded at eight rounds: a runaway loop is a cost incident.

Turns are persisted in `AgentMessage` with the tool steps they took, so the
console can show HOW an answer was reached rather than asking anyone to trust it.

**Voice** is the browser's Web Speech API. It produces text, and that text
follows the identical path; the audit record differs only by channel.

### 10.7 Revenue advisory engine

`packages/domain/src/revenue.ts` — pure, 15 unit tests.

`computeMetrics()` does arithmetic with no opinions. Two choices matter:

- **Capacity is physical rooms x nights**, not what the channel manager left
  open. Using open inventory as the denominator flatters occupancy exactly when
  a hotel is closing itself out by mistake — the case we most need to see.
- **RevPAR is revenue over capacity**, not the product of two rounded numbers.

`advise()` produces findings, each carrying its own numbers, a lever
(RATE / INVENTORY / RESTRICTION / PROMOTION / DISTRIBUTION / CONNECTIVITY / DATA),
an owner and sometimes a ready-to-approve command:

| Finding | What it separates |
|---|---|
| `DATA_QUALITY`, `STALE_INVENTORY` | Bad data comes before any commercial advice |
| `INSUFFICIENT_DEMAND_DATA` | The confidence gate: under 12 bookings, no demand-based call |
| `REVPAR_DECOMPOSITION` | Whether rate or volume is the constraint |
| `PRICED_ABOVE_MARKET` | Commercial gap → targeted promotion, not a BAR cut |
| `FLAT_RATE_UNEVEN_DEMAND` | Flat pricing against uneven day-of-week demand |
| `CTA_BLOCKING`, `MINLOS_AGAINST_PATTERN` | Restrictions fighting the real booking pattern |
| `SHORT_BOOKING_WINDOW` | Which promotion type actually fits the pace |
| `PARTNER_NET_VALUE_GAP` | Net contribution per room night, which ranks channels differently from gross |
| `SEARCHED_NOT_BOOKED` | Visibility without conversion |

Currency is normalized to the property currency before aggregation, and the
conversion count and source are reported on the metrics.

### 10.8 Audit trail

Every action records: who, how (voice/chat/API), which agent, which model (or
"grammar"), the utterance, the structured command, the policy decision with every
check, the simulation, the confirmation, the execution result, and rollback
availability.

---

## 11. Event catalog

47 event types in `packages/contracts/src/events.ts`, grouped: Catalog,
Connectivity, ARI, Commercial, Demand, Booking, Reconciliation, Agent.

Every event carries `id`, `type`, `tenantId`, `partitionKey`, `payload`,
`correlationId`, `occurredAt`, `version`. Ordering is guaranteed only within a
partition key.

**Transactional outbox**: the event row is written in the same transaction as the
domain change it describes. Either both land or neither does. Publishing from
application code after a commit is where "the booking exists but nobody was told"
comes from.

---

## 12. API surface

### Public (gateway, `/api/v1`)

```
POST /auth/login                      GET  /me
GET  /overview
GET  /properties                      GET  /properties/:id/workspace
GET  /properties/:id/calendar         GET  /properties/:id/ledger
GET  /properties/:id/diagnose         POST /properties/:id/approve
GET  /connectivity/health             GET  /connectivity/providers
POST /connectivity/providers/:p/conformance
POST /connectivity/connections/:id/pull
POST /connectivity/connections/:id/health-check
GET  /promotions                      GET  /contracts
POST /search                          POST /bookings           GET /bookings
GET  /agent/capabilities              POST /agent/ask
POST /agent/actions/:id/confirm       POST /agent/actions/:id/reject
POST /agent/actions/:id/rollback      GET  /agent/actions
POST /reconciliation/run              GET  /reconciliation/runs
GET  /audit
```

### Provider-facing

```
POST /webhooks/:connectionId/ari      signature-authenticated, not session
```

### Canonical search contract

`POST /api/v1/search` → `SearchResponse` with `offers[]` and `excluded[]`.
Every offer carries the full price breakdown, currency provenance, ARI
provenance, the sellability trace, an HMAC signature and a TTL.

Wetriip AI receives `HotelOffer[]` and chooses which offers best satisfy the
traveller's intent. **It never computes a price.**

### Error taxonomy

Seventeen codes (`VALIDATION`, `PERMISSION`, `STALE_VERSION`, `CONFLICT`,
`INCOMPLETE_MAPPING`, `POLICY_DENIED`, `STEP_UP_REQUIRED`, `OFFER_EXPIRED`,
`CIRCUIT_OPEN`, …), each with an owner, a remediation and a correlation id. The
audit named ambiguous empty states as a real operational cost; this is the
control.

---

## 13. Security model

| Control | Implementation |
|---|---|
| Tenant isolation | `tenantId` in every key, query, log and cache entry; carried in `RequestContext` |
| Authorization | 34 permissions; ten roles are named bundles. `effective = bundle + grants − revokes`, resolved once at the gateway (ADR-008) |
| Enforcement point | The gateway, the only component that authenticates a human. `guard('<permission>')` per route; internal services trust the context headers because only the gateway can mint them |
| Delegation limits | A hotel administrator cannot mint Wetriip staff, cannot grant `PLATFORM_ONLY_PERMISSIONS`, and cannot grant what they do not hold. The last active administrator cannot be disabled |
| ABAC | Organisation, property, market, channel evaluated in contract resolution and sellability. Property scope (`propertyIds`) is a separate axis from permission |
| Agent authority | `min(user.maxAutonomy, platform ceiling)`; never exceeds the caller. `COMMAND_PERMISSIONS` maps every command kind to a permission, tested for completeness |
| Account lifecycle | Disabled, never deleted — the audit trail must still resolve the name. `assertCan` is false and `login()` refuses before a session exists |
| Group negotiation | `groups.write` (load inventory) is separate from `groups.negotiate` (commit a price). A buyer holds the latter for its own side, scoped by organization — it cannot answer its own request or read another agency's bids |
| Outbound messaging | Recorded, never assumed. `NOT_CONFIGURED` carries the outstanding requirement; nothing is marked SENT unless a provider accepted it |
| Step-up | Required for every HIGH-risk action; `STEP_UP_REQUIRED` until proven |
| Secrets | Vault reference on the connection row; resolved at call time; never persisted, returned or logged |
| Log redaction | Key-name based, enforced in the logger rather than trusted to callers |
| Webhook auth | Provider signature over the raw body; the raw body is preserved for verification |
| Audit | Append-only, no update or delete path |
| Idempotency | Database primary key as the lock |

**[NOT BUILT]** OIDC/JWKS at the gateway, mTLS between services, field-level PII
encryption, WAF, SBOM/signing in CI. The seams exist; the integrations do not.

---

## 14. Observability

Four layers, because each answers a different question and mixing them is how
incidents take hours instead of minutes:

| Layer | Question | Metrics |
|---|---|---|
| Connection | Can we talk to the partner? | auth success, latency, rate-limited, circuit state |
| Ingestion | What did we receive and accept? | received, accepted, rejected, duplicates, out-of-order, ingest latency |
| Effective | What ended up sellable? | stale cells, sellable ratio, materialize latency |
| Commercial | What did the buyer search and buy? | search latency, offers, excluded, booking outcomes |

Percentiles, not averages — p50/p95/p99. Every log line carries a correlation id
that follows a change from the provider's webhook to the buyer's search.

### SLOs (encoded in `contracts/topology.ts`)

| Indicator | Target | Window |
|---|---|---|
| ARI push materialized | 99% < 60 s | 30 days |
| Search availability | 99.95% | 30 days |
| Search latency p95 | < 800 ms | 7 days |
| Booking outcome determined | 99.9% < 2 min | 30 days |
| Duplicate bookings | 0 | always |

---

## 15. Reconciliation

Verifies each hop independently, because each breaks differently:

```
SOURCE  ≈  LEDGER  ≈  EFFECTIVE  ≈  DISTRIBUTION
```

Divergence kinds: `MISSING_EFFECTIVE`, `PRICE_MISMATCH`, `AVAILABILITY_MISMATCH`,
`STALE_EFFECTIVE`, `OFFER_UNBACKED`.

Divergences are **recorded, never auto-corrected**. Silently fixing a mismatch
destroys the evidence needed to find the cause, and the cause is usually upstream
of us. A cell with a managed override is not a divergence.

---

## 16. Design language

From the Brand Manual, encoded in `web/src/styles.css`:

- Magenta `#EC4899` — identity only: the wordmark's two i's, the isotype accent,
  AI/brand badges. **Never a functional state.**
- Midnight `#0F1729` — structure. Canvas `#FBF7F4` — application background.
- Success `#10B981` · Warning `#F59E0B` · Danger `#EF4444` · Info `#3B82F6`.
- Primary actions are **green or midnight**, never magenta. Verified: the console
  renders zero magenta buttons.
- General Sans, three weights, modular 1.25 scale, negative tracking that scales
  with size. No gradients.

The console's information architecture takes what the audit found useful in the
reference platform and fixes what it found broken:

- **AI Command Center is top-level**, not a hidden chat bubble.
- **Four separate badges** — Approval, Connection, ARI, Contracts — because the
  audit's sharpest finding was that a single "Approved" badge gets read as
  operational health.
- **Empty states state their cause.** "No inventory for this combination" is
  followed by whether that means never-received, filtered, or genuinely empty.
- The copilot is **context-aware**: property, room, rate plan and selected dates
  travel with the utterance.

---

## 17. Roadmap

| Phase | Outcome | Exit criteria |
|---|---|---|
| **0 — Foundation** ✅ | Domain model, ARI ledger, agent command path, deterministic grammar | Ships in this repo: 57 unit tests, 27/27 end-to-end checks |
| **1 — First real CM** | One certified channel manager in production | Conformance suite green; certification booking and cancellation with no double effect |
| **2 — Extranet depth** | Rate calendar editing, bulk restrictions, taxes UI, mapping review UI | A revenue manager runs a week without the API |
| **3 — Agentic depth** | Voice (STT/TTS around the same command path), richer diagnostics, recommendations | Voice command path produces identical audit records to chat |
| **4 — Commerce** | Contract workflow with four-eyes approval, promotion approval, buyer eligibility UI | A contract cannot be published by one person alone |
| **5 — Distribution** | Push subscriptions to buyers, marketplace, P2P at depth 2 | Cursor, ACK, backlog and replay observable per subscriber |
| **6 — Intelligence** | Rate-shopper integration, demand signals, revenue recommendations | Recommendations measured against outcomes, not vibes |
| **7 — Autonomy** | Policy-bound autonomous operation (`AgentPolicy`) | Four weeks under <2% intervention rate before raising any tenant to L3 |

### Immediate next sprint

1. Certify one real channel manager against the conformance suite.
2. Replace the gateway's HMAC session with OIDC.
3. Move the event bus to Redpanda behind the existing interface.
4. Rate-shopper integration to replace the comp-set proxy.
5. Voice: STT in front of the existing `/agent/ask`, TTS on the response. The
   safety path does not change — that is the point of routing every channel
   through the same command.

---

## 18. The eight assets worth protecting

1. **Universal Travel Supply Schema** — `@wetriip/contracts`
2. **Travel Connectivity SDK** — adapter contract, runtime, conformance suite
3. **Effective ARI Engine** — layered, explainable, deterministic
4. **Sellability Engine** — predicates with evidence, owner and remediation
5. **Contract & Promotion Engine** — commercial rules as data
6. **Agent Action Runtime** — natural language to safe execution
7. **Travel Genome** — traveller preference graph **[NOT BUILT]**
8. **Unified Travel Graph** — hotel + activity + transfer + traveller **[NOT BUILT]**

Six of the eight exist and are tested. The company is in those, not in the
interface.
