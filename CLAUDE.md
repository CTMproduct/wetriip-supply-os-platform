# Wetriip Supply OS — working rules

> **THE LLM MAY DECIDE WHAT THE USER MEANS.**
> **IT MAY NEVER DECIDE WHAT THE USER IS ALLOWED TO DO,**
> **WHAT STATE IS TRUE, OR WHETHER A SIDE EFFECT SUCCEEDED.**
>
> Every rule below is that sentence, made structurally impossible to violate.

## Non-negotiable

1. **The LLM never modifies inventory, price, contracts or bookings.** Its only
   output is a `StructuredCommand`. If a feature needs the model to act, the
   feature is wrong — add a command kind with a policy path, a simulation path
   and an inverse for rollback.
2. **The ledger is append-only.** No update, no delete, no status rewrite on
   `AriEvent` or `AuditEvent`.
3. **External is never overwritten by Managed.** Overrides are a separate layer
   with an actor, a reason and a validity window.
4. **Contractual and promotional adjustments never enter the ARI ledger.** They
   belong to offer construction.
5. **Deterministic engines do no I/O.** Anything in `packages/domain` must be a
   pure function of its inputs, or it does not belong there.
6. **Every write path is idempotent.** If you cannot name the key, you are not
   finished.
7. **Agent authority is derived from the user**, never granted independently.
   The agent carries the caller's resolved permissions and property scope. If a
   new command kind is not in `COMMAND_PERMISSIONS`, a test fails.
8. **Content is layered like ARI.** An import lands in EXTERNAL and can never
   overwrite what the hotel wrote in MANAGED. An imported image without a
   credit and a licence is withheld from publication, not shown.
9. **Distribution is evaluated before contracts and before pricing.** A hotel
   closed to a market must never reach the point of having a rate computed.
10. **Credit only moves through the ledger.** `creditUsed` is a running total of
   `CreditEntry` rows and is never set directly.
11. **Empty states state their cause.** Never return an empty array where a typed
   error with an owner and a remediation would tell the operator what to do.
12. **The permission is the unit of authority; a role is a bundle.** Resolution
   is `role + grants − revokes`, revocation last and unconditional, resolved once
   at the gateway. Never write `if (role === …)` at a write path — add a
   permission and enforce it. Property scope and autonomy are separate axes and
   must stay that way.
13. **Nobody hands out authority they do not hold**, and no permission that lets
   a tenant see another tenant may be grantable from inside a tenant.
14. **Group inventory is declared, not observed.** A block has TWO constraints —
   per-bedding maxima and a physical ceiling — and availability is derived from
   live requests, never stored as a counter. **Accepting a group decrements real
   availability** in the MANAGED layer, pushes it to the channel manager, and
   records the outcome including failure. Only ACCEPTED decrements; a live
   negotiation holds rooms inside the block only.
15. **A negotiation is append-only and on a stored clock.** A counter-offer is a
   new row. The expiry the hotel sees and the expiry the sweeper enforces are the
   same value. A live offer holds inventory.
16. **Never report a notification as sent unless a provider accepted it.**
   `NOT_CONFIGURED` with the outstanding requirement is the honest state, and it
   is what the console must show.
17. **Identity is signed, never asserted.** Internal services refuse context they
   cannot verify. Never read authority from an unsigned header, and never treat
   network position as authentication.
18. **Step-up is a proof bound to one action**, never a boolean. If it could be
   replayed against a different change, it is not step-up.
19. **A proposal carries a binding, and confirmation re-checks everything.**
   Authority, policy and the state the numbers came from are re-evaluated at
   confirmation. An approval must never store authority.
20. **State transitions are conditional updates, not read-then-write.** Guard on
   the current status and assert exactly one row changed. Applies to
   confirmations, rejections, bookings, group acceptance and credit.
21. **When uncertainty touches money, fail closed.** Unknown credit is not
   approved credit. A dependency that cannot answer means refuse, not proceed.
22. **Every tool the assistant can call declares the permission it needs.** The
   enforcement point is code, before the dispatch. A prompt is not a security
   boundary.
23. **Scope is a primitive, not a rule to remember.** Compose `propertyScope(ctx)`
   into the query. Never `{ id, ...propertyScope(ctx) }` — the spread overwrites
   the id and answers with a different row. Use `scopedPropertyWhere()`.
24. **Idempotency keys are namespaced per tenant.** Two companies must never be
   able to collide on the same key.
25. **A status code is not a cause.** A response with no platform `error` object
   did not come from the platform; say the platform is unreachable and name the
   path. Never surface a bare "Request failed (500)".
26. **Identity is never served from cache.** The console may show a stale rate
   with its age; it may never show a stale *user*. `/api/v1/me`, `/users` and
   `/admin/*` fail loudly instead of falling back, and switching session clears
   the cache so one person's data cannot survive into another's console.

## Where things go

| Concern | Home |
|---|---|
| Types, schemas, event names, error codes | `packages/contracts` |
| Any deterministic decision | `packages/domain` (+ a `.spec.ts`) |
| Provider dialects | `packages/connectivity-sdk/src/adapters` |
| Cross-service plumbing | `packages/service-kit` |
| Persistence, outbox, audit | `packages/persistence` |
| Business orchestration | the owning service |
| Groups, blocks, negotiation, event space | `services/groups` |

## Integrations that are legal before they are technical

Booking.com, Expedia, GIATA and Gimmonix content sources are registered and
**uncertified**. The blocker is a partner agreement and image redistribution
rights, not code. Do not implement a scraper: it breaches their terms and
exposes the hotel as well as us. Add the adapter when the agreement exists, and
record `redistributionPermitted` honestly — it decides whether the integration
may exist at all.

A service reads and writes **only its own tables**. Reaching another domain is an
API call or an event, never a join. The ownership map is in
`packages/persistence/src/index.ts`.

## Before every commit

```bash
npm run build && npm test
```

Then, if a domain rule changed, run the end-to-end checks against a live server:

```bash
node scripts/smoke.js
```

## Adding a channel manager

1. One class implementing `ChannelManagerAdapter`.
2. Declare capabilities **per operation** and rate limits honestly.
3. Fixtures for `parsePush`; it is pure, so test it against recorded payloads.
4. `runConformance(adapter)` must report `certified: true`.
5. Register it in `services/connectivity/src/registry.provider.ts`.

Do not enable a connection whose adapter is not certified. A stub that returns
empty results is how a hotel ends up "connected" to a provider that has never
sent a byte.

## Before touching auth, scope or confirmation

Read [ADR-010](docs/adr/ADR-010-control-plane-hardening.md) first. It records
fifteen specific holes and what each one allowed. Reintroducing one of them is
easy; the ADR exists so it cannot be done unknowingly.

## Adding a permission

1. Add it to `PERMISSIONS` and `PERMISSION_LABELS` in
   `packages/contracts/src/permissions.ts` — the label is what a general manager
   reads in the tick-list, so write it as a capability, not as a code.
2. Put it in the role bundles where it belongs. A permission no role holds is
   dead code and `permissions.spec.ts` will say so.
3. If it lets one tenant see another, add it to `PLATFORM_ONLY_PERMISSIONS`.
4. Enforce it: `this.guard('<permission>', authorization)` on the gateway route.
   Enforcement lives at the gateway because it is the only component that
   authenticates a human.
5. If an agent command should reach it, map the command in
   `COMMAND_PERMISSIONS`.

## Adding an agent command

1. Add the shape to `StructuredCommandSchema`.
2. Extend the deterministic grammar and add grammar tests — the model is not the
   only path, and it is not the tested one.
2b. If the assistant should be able to reach it, add it to the system prompt in
   `conversation.prompt.ts`. `propose_change` is the only write tool and it
   never executes.
3. Add a risk assessment in `assessRisk` and any numeric gate in
   `evaluatePolicy`.
4. Add a simulation branch that produces real counts and a confirmation sentence.
5. Add an execution branch that writes to the MANAGED layer only.
6. Add an inverse in `buildInverseCommand`, or state explicitly that it cannot be
   rolled back.

## Brand

Magenta `#EC4899` is identity, never a functional state. Primary actions are
green (success) or midnight. No gradients. Three weights of General Sans.
The console renders zero magenta buttons — keep it that way.

## Environment notes

- This workspace lives under a OneDrive path with spaces. `.cmd` shims break;
  always invoke `node node_modules/<pkg>/...` directly rather than `npx`.
- PostgreSQL 17 runs natively on `localhost:5432`; prefer it over Docker.
- Build order is explicit in `scripts/build.js` — npm workspaces has no
  topological build.
