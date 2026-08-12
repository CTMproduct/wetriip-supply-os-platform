# Wetriip Supply OS

**The agentic operating system for travel supply.**

An extranet where a hotel talks to the platform in plain language, and a
deterministic system decides what actually happens.

---

## The one architectural rule

> **The LLM never modifies inventory, price, contracts or bookings.**

A model's only output is a `StructuredCommand` — a value in a closed, Zod-validated
union. Anything it cannot express, it cannot do. From that point the path is
entirely deterministic and identical whether the command came from a model, from
the grammar parser, from a REST client or from a button:

```
utterance → intent → StructuredCommand → simulation → policy
          → confirmation → execution → verification → audit
```

That is what stops a misread sentence from becoming 1,000 rooms at USD 1.

The platform runs **without an API key**. A deterministic grammar (Spanish and
English) produces the same commands, so the system can be tested and certified
with no model in the loop. The LLM handles the long tail; the common path is
reproducible.

---

## Running it

Requires Node 20+ and PostgreSQL.

```bash
npm install
```

```bash
cp .env.example .env
```

```bash
npm run prisma:migrate
```

```bash
npm run build
```

```bash
npm run seed
```

```bash
npm run dev
```

Then, in a second terminal, populate inventory through the real connectivity
pipeline (adapter → canonical events → ledger → effective ARI):

```bash
npm run bootstrap:ari
```

Open <http://localhost:3100> and sign in as one of the seeded people — the
console changes shape depending on who you are:

| Sign in as | You get |
|---|---|
| `melisa@caribehotels.co` | Revenue manager — rates, availability, promotions, distribution |
| `gerencia@caribehotels.co` | General manager — the above plus **Team** |
| `ecommerce@caribehotels.co` | E-commerce analyst — reads and proposes, writes nothing |
| `pipe@wetriip.ai` | Wetriip staff — adds **Platform**, the cross-tenant view |

Email-only sign-in is a development shim and **authenticates nobody**. In
production the process refuses to start without `OIDC_ISSUER`, a real step-up
verifier and high-entropy secrets — see `assertProductionPosture`.

### Verify it

```bash
npm test
```

```bash
node scripts/smoke.js
```

The smoke run exercises the claims that matter: idempotent re-ingest, the
diagnostic engine, an agent that proposes but cannot execute, a policy refusal,
confirmed execution, rollback-as-new-version, signed offers, booking idempotency
under replay, and — making the same request as three different people — that a
refusal names its reason.

---

## The AI Command Center

A full-surface assistant, not a command bar. It holds a thread, streams, shows
the tools it reached for, and renders results as cards. Voice in (push to talk)
and voice out are the browser's own speech engine, so no audio leaves the
machine.

What keeps it safe is the tool split, not restraint:

| | |
|---|---|
| **Read tools** | Execute immediately. None of them change anything. |
| **`propose_change`** | Cannot execute. It validates a `StructuredCommand`, simulates it against live inventory, evaluates policy, and returns a **proposal** with its blast radius. A human presses Confirm. |

So the model can be as fluent as it likes about revenue strategy and still
cannot move a single rate on its own.

It can change rates, availability, minimum-stay and other restrictions, and
create, edit, pause or cancel promotions — including **geo-targeted**
(`audience.markets`) and **agency-exclusive** (`audience.organizationIds`) ones.

### As a revenue manager

The advisory engine computes the numbers; the assistant explains them.

```
RevPAR = ADR x occupancy   →  which one is your constraint?
```

It reads occupancy, ADR, RevPAR, booking pace, length-of-stay pattern,
day-of-week spread, rate position against a comparable set, and partner
production **net of commission** — because gross production ranks channels
wrong.

Two rules make it trustworthy rather than merely fluent:

1. **Every metric carries a confidence grade based on sample size.** Below
   twelve bookings the engine describes pricing position and inventory — which
   are observable — and explicitly refuses a demand-based recommendation.
   A rate call built on four bookings is worse than none, because someone acts
   on it.
2. **The model may not state a number a tool did not return.** The arithmetic
   and the findings are computed in `packages/domain/src/revenue.ts` and unit
   tested; the model narrates them.

Booking amounts are converted into the property currency before aggregation —
an agency in Mexico pays MXN for a hotel that invoices COP, and averaging those
produces an ADR that is not a price in any currency. The conversion count and
its source are reported, not hidden.

---

## The hotel profile

Everything that makes a hotel a hotel rather than a row of prices: photos,
descriptions, address, amenities, check-in times, policies.

It carries the **same layering as ARI**, for the same reason:

| Layer | Origin | Rule |
|---|---|---|
| `EXTERNAL` | An import | Never overwrites the hotel's own text |
| `MANAGED` | The hotel, in the extranet | Wins field by field |
| Effective | Computed | With per-field provenance and a completeness score |

A hotel that fixes its own description and finds it reverted by tonight's feed
never trusts the extranet again. An imported empty string can never blank out
what the hotel wrote.

**Imported images are withheld until their credit and licence are recorded.**
Publishing somebody else's photograph without knowing the terms is a real legal
exposure, not a nicety.

### On Booking.com and Expedia

Neither publishes a content API a third party may call to pull an arbitrary
hotel's profile. That is a licensing position, not a technical gap, and
scraping breaches their terms and exposes both us and the hotel.

The legitimate routes, all of which need paperwork before code:

- **Booking.com Content API** — the property's own Connectivity Partner
  credentials under Booking's partner agreement.
- **Expedia Rapid / Partner Central** — the property grants access under its
  Expedia partner agreement.
- **GIATA / Gimmonix** — commercial content aggregators, which exist precisely
  because this problem is licensing rather than scraping.
- The channel manager already connected, which often carries content alongside ARI.

All four are registered in the console with their exact outstanding
requirements, and every call fails with `NOT_IMPLEMENTED` until the agreement
and credentials exist. A stub returning empty content would look identical to a
hotel with no photos.

---

## Distribution: marketplace, geo, or one wholesaler

A **distribution policy** is the hotel's own answer to "who may see me", and it
is deliberately separate from a contract. A contract says *these are our terms
with this buyer*; a policy says *this hotel is open to the marketplace* or
*only to Viatur and two others, and only for the US and UK*.

```
MARKETPLACE_OPEN     every buyer with an active contract
SELECTED_PARTNERS    only the organizations on the allow list
CLOSED               not distributed at all
```

Plus per-market allow/deny, partner-type and channel restrictions, a booking
window, a minimum stay, and a **rate floor that overrides any contract** — a
contract signed last year should not be able to sell below the floor the hotel
set this morning.

It is evaluated **before contracts and before pricing**. A hotel closed to a
market never reaches the point of having a rate computed, which is how a rate
stays out of a channel the hotel excluded. Every rule reports its own result,
so the console can say *"Mayorista MX cannot see this hotel because it
distributes to 1 selected partner and this is not one of them"* instead of
showing an empty list.

---

## Partners: code, tax identity, credit

A wholesaler is a legal entity, not a name on a contract. Each carries a stable
`partnerCode` (quoted on bookings and invoices, immutable once issued), a tax
identity **with its scheme** — a Colombian NIT and a Mexican RFC have different
shapes and different invoicing obligations — billing details, source markets,
payment terms and a credit line.

Credit is an **append-only ledger**. `creditUsed` is its running total and is
never set directly; a balance somebody can type over is a balance nobody trusts.
`HOLD` and `CHARGE` increase exposure, `RELEASE` and `PAYMENT` reduce it, and
every entry records the balance after it so any row is auditable on its own.

The check runs **before the supplier is contacted**, so a partner over their
limit never creates a reservation we then have to unwind. A booking priced in
USD against a COP credit line is converted at a recorded rate rather than
refused — that is ordinary multi-currency operation.

---

## Demand intelligence

Every search writes **one impression per property**, carrying the buyer, their
source market, the destination, and — when we could not quote — the predicate
that stopped us.

That last field is the whole point. "2,400 searches, 0 bookings" is a mystery.
"Mayorista MX looked at your hotel 2,400 times and 1,900 produced no offer
because the Junior Suite has no inventory" is a Tuesday morning task.

From the same stream, read from opposite ends:

- **Emisivo (outbound)** — anchors on a source market: where are buyers selling
  from Colombia actually searching?
- **Receptivo (inbound)** — anchors on a destination country: who is looking at
  Colombia, and is it rising or falling against the previous window?

Every figure carries a sample size and a confidence grade, and a trend is only
computed against a prior window with at least ten observations. The API states
plainly that this is demand observed on **this platform**, not a national
tourism statistic — a wholesaler planning contracting needs to know which one
they are reading.

---

## Who gets in, and what they may touch

A hotel is not one person, so the extranet is not one login. The permission is
the unit of authority; a role is a named bundle of permissions, and the general
manager tailors it per person:

```
effective = role bundle  +  grants  −  revokes
```

Revocation is last and unconditional — a manager who takes something away must
not find the role handing it back.

| Role | Does | Cannot |
|---|---|---|
| **Gerente general** | Runs the team: enables, disables and permissions users. Full commercial authority. | — |
| **Revenue manager** | Rates, availability, restrictions, promotions, distribution, inventory refresh. Confirms and rolls back agent actions. | Administer users. Publish a contract. |
| **E-commerce** | Reads everything commercial, analyses demand and the competitive set, and **proposes** through the assistant. | Write anything. Confirm its own proposal. |
| **Reservas** | Day-to-day bookings and cupos. | Touch price. |
| **Finanzas** | Wholesaler credit, invoicing, production. | Touch inventory. |
| **Conectividad** | Channel managers, mappings, inventory health. | Touch commercial terms. |

Three things are deliberately independent:

- **Role** — *what* you may do.
- **Property scope** — *where*. Empty means every property in the organization.
- **Autonomy (L1–L3)** — how far the assistant may go on your behalf before a
  human confirms. Someone can hold `rates.write` at L1: they may change rates,
  the agent may only propose them.

The e-commerce analyst is the case worth understanding. They hold `agent.use`
but not `agent.execute`, so they can ask the assistant to raise rates, watch it
parse the command, watch it simulate the blast radius — and watch it refused by
name at the `PERMISSION` check. The analyst finds the opportunity; somebody with
authority signs it off. That refusal is the design.

A departing colleague is **disabled, not deleted**: the audit trail must still
render their name against the changes they made, while `login()` refuses the
account before a session exists. The last active administrator of an
organization cannot be disabled or demoted at all.

### Wetriip's own view

`Platform → Tenants · Users · Activity` shows every tenant, every account and
every action any of them took. It is gated on permissions no hotel role holds
and no hotel administrator can grant — so however a hotel configures its own
team, it cannot reach across to another. It is read-only: seeing what a tenant
did is support; acting as them is not.

Full reasoning in [ADR-008](docs/adr/ADR-008-roles-and-permissions.md).

---

## Groups: inventory, gratuidad, and a negotiation on a clock

A group is not a booking with a bigger number, so it does not go through ARI.
Three things are structurally different and each one earns its own machinery.

### The block declares what is held back

The hotel loads exactly how many **twin** and how many **double** it will hold
for group business — plus the **physical ceiling**, because the same twenty
rooms convert between the two. A block of 20 can legitimately offer *up to 18
twin* and *up to 20 double* at the same time, and only twenty rooms exist.
Both constraints are checked; conflating them is the classic group oversell.

Availability is derived from the live requests, never stored as a counter. A
counter that has to be maintained is a counter that drifts.

### The gratuidad is arithmetic, not a note in a PDF

"Una gratuidad por cada 20 habitaciones" is parametrised once and computed the
same way every time: one unit per N **paid** rooms, so 21 rooms earns one free
room and not one-and-a-fraction, on a per-stay or per-night basis that the
result names.

The number that matters is the one hotels most often miss:

> Fifteen rooms at 100 with one free **is not 100 a room.**

The comp room occupies room-nights that are never billed, so the same money
spreads over more nights. The platform shows the headline ADR and the **net**
ADR side by side, and measures the floor against the net one.

### Accepting takes the rooms out of sale

A block that exists only inside Wetriip is a block Booking.com oversells on a
Tuesday. When a group is accepted, its rooms leave the sellable pool: a MANAGED
decrement across every rate plan on that room type, for the nights the stay
actually occupies, pushed outward to the channel manager.

Only **acceptance** decrements — a live negotiation holds rooms inside the block
so two agencies cannot both be told yes, but an offer that lapses must not have
withheld real inventory for a day.

Accepting and decrementing live in two services and cannot be one transaction,
so the request carries the outcome: `APPLIED` with the cell count, or `FAILED`
with the reason — visible, retryable, and retried by the sweeper. If the block
promised more rooms than the channel manager ever published, the **shortfall is
counted and reported** rather than floored at zero in silence.

### The negotiation

An agency arrives with a **budget**, not a search: *ten people, eight thousand
dollars, take it or leave it.* The platform turns that into a per-room-night
figure, compares it to the hotel's own floor, and — when it falls short — says
so **in money**:

```
10 rooms × 3 nights = 30 room-nights.
Budget 10,000,000 ÷ 30 = 333,333 per room-night.
Floor is 380,000. Accepting gives up 1,400,000 against it.
```

That is a verdict, never a decision. A hotel taking a low group to fill a
shoulder date is a legitimate choice; the engine only makes sure it is not an
accidental one.

Rounds are **append-only** — a counter-offer is a new row, never an edit — and
each one carries an expiry computed from the hotel's own response window
(24 hours by default). A live offer **holds** the rooms, so two agencies cannot
both be told yes for the same block. The countdown the hotel sees and the
deadline the sweeper enforces are the same stored value.

The one automatic path is auto-decline below floor. It is off by default,
because a hotel usually wants to know somebody asked, and when it fires the
record says the rule declined it — not a person.

### Notifications

Every state change enqueues a message to the addresses and WhatsApp numbers the
hotel configured, naming the agency — a hotel decides differently depending on
who is asking.

What the platform does **not** do is pretend to deliver. Email needs SMTP
credentials; WhatsApp needs a Meta Business account, a verified sender and a
Meta-approved template before a single business-initiated message is allowed.
Until those exist the row is stored as `NOT_CONFIGURED` with the exact
outstanding requirement, and the console says so. A stub that logs "sent" is how
a hotel finds out three months later that nobody was receiving anything.

---

## Salones de eventos

A salón is sold by time or by head, its capacity depends on how the chairs are
arranged, and half its revenue is attached to it rather than in it. So it is
priced by its own fixed pipeline:

```
SPACE → SETUP → EQUIPMENT → CATERING → TAX
```

- **Capacity is per layout** — auditorio, escuela, en U, en L, junta, imperial,
  banquete, cóctel, cabaré. The same room seats 120 in auditorio and 28 en U, so
  quoting 80 people into the U is **refused**, naming the layout that would have
  held them. Discovering that on the morning of the event is the failure this
  prevents.
- **The cheapest applicable unit wins.** Four hours priced by the hour when the
  half-day rate is lower is how a hotel loses a quote it should have won. The
  quote says which unit it charged and what the others would have cost.
- **Equipment and catering are separated**, because they are different
  decisions — videobeam, micrófono, pantalla, sonido, WiFi against coffee break,
  almuerzo, barra libre.
- **Included items are listed at zero**, not hidden, so the client can see what
  they are getting.

Every line carries the arithmetic that produced it, and tax comes from the
property's own tax rules rather than a constant.

Both salones and the gratuidad rule can be **dictated** to the AI Command
Center. Reciting capacities and prices out loud is faster than a form, and
getting a configuration wrong oversells nothing — so it is the one place the
assistant genuinely earns dictation. Answering an agency is not: that commits
rooms and money to a third party, so it is always HIGH risk, always needs
step-up, and has no undo.

---

## Topology

Nine independently deployable services, split along **failure isolation and
scaling curves** rather than along database tables.

```
                          USERS / SYSTEMS
   Hotel voice · Hotel console · Agency portal · Channel managers
                                │
                        ┌───────┴────────┐
                        │    GATEWAY     │  :3100  auth · BFF · console
                        └───────┬────────┘
        ┌───────────────┬───────┼────────┬───────────────┐
        ▼               ▼       ▼        ▼               ▼
  CORE-COMMERCE   CONNECTIVITY  ARI    SEARCH        BOOKING
     :3110          :3120     :3130    :3140          :3150
  catalog          adapters   ledger   sellability    saga
  mapping          webhooks   layers   pricing        idempotency
  contracts        pull jobs  effective offers        UNKNOWN state
  promotions       circuits   health
        │               │       │        │               │
        └───────────────┴───────┼────────┴───────────────┘
                                ▼
                    AGENT :3160    RECONCILIATION :3170
                    intent         source ≈ ledger ≈
                    policy         effective ≈ distribution
                    simulation
                    execution
```

**Why these boundaries.** `connectivity` talks to dozens of third-party APIs
with their own rate limits, latencies and bad days; it must never be able to
take down search or booking. `ari-ingestion` is write-heavy and partition-ordered.
`search` is read-heavy with an 800 ms p95 budget. `booking` is low-volume and
the highest-criticality path. `agent` carries LLM latency and cost on a
completely different scaling curve. Catalog, contracts and promotions are
transactional and low-volume, so they stay together on purpose.

`services/all-in-one` boots every module in one process for laptops and CI —
same code, same route prefixes, same HTTP calls between services. A topology you
can only run in production is a topology nobody tests.

Run them separately with `npm run start:connectivity`, `npm run start:search`, etc.

---

## Layout

```
packages/
  contracts/          canonical types, Zod schemas, event catalog, error taxonomy
  domain/             every deterministic decision — pure, no I/O, 100 unit tests
  connectivity-sdk/   adapter contract, registry, resilience runtime, conformance suite
  persistence/        Prisma schema, outbox, audit ledger, idempotency store
  bus/                event bus (transactional outbox / in-memory), partitioned dispatch
  observability/      structured logs with redaction, four-layer metrics
  service-kit/        request context, error filter, health, inter-service clients

services/             the eight deployables above + all-in-one host
web/                  console (React, Wetriip brand tokens)
docs/                 CTO blueprint and ADRs
```

`packages/domain` is where the IP lives: the Effective ARI engine, the
Sellability engine, the pricing pipeline, the promotion DSL evaluator, the
policy engine, the simulation engine, the revenue advisory engine, the content
and distribution engines, the demand analytics and the intent grammar. Nothing in it does
I/O, so every one of those decisions is reproducible from its inputs alone.

---

## What is real and what is not

**Real and exercised end to end:** the conversational Command Center with
streaming, tool use and voice; the revenue advisory engine; layered hotel
content with licensing gates; distribution policy enforced before pricing;
partner profiles with an append-only credit ledger; demand intelligence and
outbound/inbound travel flow; the ARI ledger with idempotency and
out-of-order handling; External/Managed/Effective layering; the sellability
predicate engine; the pricing pipeline with full currency provenance; the
promotion DSL; contracts; signed offers with TTL; the booking saga including
`UNKNOWN`; the agent control plane with policy, simulation, confirmation,
execution, audit and rollback; reconciliation; the connectivity runtime with
rate limiting, circuit breakers and bulkheads.

**Deliberately not real yet, and marked as such in the product:**

- `SITEMINDER`, `DINGUS`, `CLOUDBEDS`, `DERBYSOFT` are registered as
  **uncertified**. Every operation fails with `NOT_IMPLEMENTED` and the
  outstanding certification checklist. They report `ok: false` on health. A stub
  that silently returns empty results is how a hotel ends up "connected" to a
  channel manager that has never sent a byte.
- The competitive set is derived from the platform's own inventory in the same
  city, and the API labels it as a proxy. A rate-shopper feed is a later
  integration.
- FX uses a static development table behind an `FxProvider` interface.
- Content sources for Booking, Expedia, GIATA and Gimmonix are registered and
  uncertified. They fail with `NOT_IMPLEMENTED` plus their outstanding
  requirements, because the blocker is a partner agreement, not code.
- Image hosting is not wired: the gallery stores URLs and renders placeholders.
- Travel flow is derived from demand observed on this platform. It is not, and
  does not claim to be, a national tourism statistic.
- Speech-to-text and text-to-speech are the browser's Web Speech API. Voice
  produces text and then follows the identical command path — swapping in a
  server-side STT provider changes `web/src/voice.ts` and nothing else.
- Sign-in is an HMAC session issued by the gateway. The claims are exactly what
  an IdP would assert; production replaces `AuthService.login` with an OIDC code
  exchange. The platform never handles a password.

---

## Documentation

- [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md) — CTO Technical Blueprint v1.0: C4
  views, ERD, ARI schema, event catalog, API contracts, security model, SLOs and
  the sprint roadmap.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — **la arquitectura completa en un solo
  documento**: los nueve servicios, los veinte motores, los 45 modelos, las 69
  rutas públicas, el front end, la observabilidad y qué está deliberadamente sin
  construir.
- [`docs/adr/`](docs/adr/) — the ten decisions that shape everything else,
  including [ADR-010](docs/adr/ADR-010-control-plane-hardening.md), which records
  fifteen control-plane holes and what each one allowed.
