# ADR-010 — The control plane must be impossible to talk into things

**Status:** accepted · implemented

## Context

An external CTO review scored the architecture highly and production readiness
at about 5/10, with a conclusion worth quoting because it is right:

> The idea is strong. The implementation is not ready for production with real
> money, inventory and bookings.

Every finding below was real. Each one is recorded with what it allowed, because
a fix nobody can explain is a fix somebody will undo.

The rule the whole platform was already trying to express, now stated at the top
of `CLAUDE.md`:

> **The LLM may decide what the user MEANS. It may never decide what the user is
> ALLOWED to do, what state is TRUE, or whether a side effect SUCCEEDED.**

## What was wrong, and what changed

### 1. Authority was a header anyone could type

`x-wetriip-permissions`, `x-wetriip-role` and `x-wetriip-tenant` were accepted by
every internal service on trust. `ContextGuard` populated them and returned
`true` unconditionally, and every service listened on `0.0.0.0`. The last line
of defence for authority was a security group.

Context headers are now **signed** (`internal-identity.ts`): HMAC over the
canonical claims plus a timestamp and nonce, with a two-minute skew window. A
service that receives unsigned or altered context refuses it. Internal services
also bind to loopback unless `BIND_HOST` says otherwise; only the gateway is
exposed. Network isolation is now defence in depth rather than the only defence.

It is symmetric on purpose — every service already shares a deployment secret,
and pretending otherwise would be theatre. When services move into separate
trust domains this becomes JWS with per-service keys and no call site changes.

### 2. Step-up authentication was a boolean the browser asserted

```
x-wetriip-step-up: true   →   stepUpVerified = true   →   confirm HIGH risk
```

That is not step-up. A step-up **proof** is now signed, expires in five minutes,
and is **bound to one action id**. It cannot be replayed against another action,
another user, another tenant, or later. `POST /auth/step-up` issues it; the
service that owns the action verifies it against that action.

Where no real verifier is configured the proof says so — `amr: ['dev']`, never
`['mfa']` — so nothing downstream can mistake a development proof for a real
factor.

### 3. Production could start with development authentication

`AuthService.login(email)` finds a user by email and issues a session. No
password, no OIDC. Secrets fell back to `'change-me-in-production'`.

`assertProductionPosture()` now runs at every service bootstrap and **throws**
when `NODE_ENV=production` and OIDC is unconfigured, a secret is a known
placeholder or under 32 characters, internal signing is disabled, or no step-up
verifier exists. Outside production it logs the same findings, so the gap is
visible long before somebody flips the flag.

### 4. The chat could reach past the caller's permissions

The gateway required only `agent.use` to open the assistant, and
`ChatToolsService.run()` dispatched on the tool name with no check. A
reservations agent without `analytics.read` could ask for the revenue advisory
and get it. The system prompt told the model not to — **a prompt is not a
security boundary.**

`TOOL_AUTHORITY` now declares, per tool, the permission it needs and how to find
the property in its own input. `authorizeTool()` runs once before the dispatch
switch, and an unknown tool is refused rather than falling through — otherwise a
tool added without an entry would inherit no checks at all.

### 5. Property scope existed and several queries ignored it

`listProperties` filtered on `tenantId` alone, so a manager restricted to two
hotels was shown the whole tenant. `propertyScope(ctx)` is now one primitive
composed into the `where` clause, and reviewing a query is "does this spread a
scope?" rather than "did the author remember three rules?".

Two things that came out of doing it properly:

- **Buyers must not be organization-scoped.** Narrowing an agency to its own
  organization hides every hotel — the inventory it exists to buy. A buyer's
  access to supply is governed by distribution policy and contracts. Caught by
  the smoke suite reporting `0 offers, 0 excluded`, which is a different failure
  from `0 offers`.
- **`{ id, ...propertyScope(ctx) }` is a trap.** The scope carries its own `id`
  clause, and the spread overwrote the requested one — so the query answered
  with a **different property and a 200**. Worse than a leak: the caller is
  shown another hotel's data under the URL of the hotel they asked for.
  `scopedPropertyWhere()` uses `AND` and a test demonstrates the trap.

### 6. Confirmation had a Time-Of-Check / Time-Of-Use hole

```
10:00  rate 100. Simulation of +10% projects 110. The user is shown 110.
10:03  the channel manager pushes 150.
10:05  the user confirms. Execution re-reads 150 and applies +10% → 165.
```

Nobody approved 165. A proposal now carries a **binding**: hashes of the
command, the ARI state it was computed on, the projected numbers and the
caller's authority, plus a 15-minute expiry. Confirmation re-takes all four and
refuses on any drift, naming which one moved — expired, state changed, authority
changed or command changed — and showing the old projection against the new.

Freezing the numbers and applying them blind would have been worse. The human
sees what changed and decides again.

### 7. Confirmation carried authority, and raced with itself

Policy was evaluated when the proposal was made and never again, so a permission
revoked in between did not stop the change. And `confirm()` was a read, a status
check, then an update — two concurrent confirms could both observe
`AWAITING_CONFIRMATION` and both execute.

Confirmation now re-evaluates policy against **current** authority and claims
the action with a conditional `updateMany` guarded on status. `count !== 1` means
somebody else won, and the loser is told so. `reject()` had the same shape and
was worse: an unconditional update by id, with no tenant check and no state
check, so any authenticated caller who learned an action id could reject
somebody else's pending change in another tenant.

### 8. Money failed open

The credit decision was `.catch(() => null)` and the booking carried on. A credit
service that was down let every booking through. **Unknown credit is not
approved credit** — it now refuses with `DEPENDENCY_UNAVAILABLE` and says to
take prepayment instead.

A credit hold that failed *after* the supplier confirmed was logged and
forgotten. It is now recorded on the booking as `HOLD_FAILED` with an audit
entry, because it is real exposure the ledger does not know about.

### 9. Idempotency keys were global

`Booking.idempotencyKey` was globally unique and the lock was `booking:<key>`.
Keys are often derived from a PMS reference or a date, so two unrelated
companies would collide and one would silently receive the other's outcome.
Keys are namespaced `tenant:<id>:<scope>:<key>` and the unique constraint is
`[tenantId, idempotencyKey]`.

### 10. Sessions asserted authority for twelve hours

A general manager could disable an account and the disabled person kept working
until the token expired. Tokens are now 15 minutes and carry an
`authorizationVersion` — a fingerprint of role, status, grants, revokes, scope
and autonomy. Any change to it invalidates outstanding tokens.

### 11. Agent sessions were not owned

`recentHistory` filtered by session and tenant but not user, and `ensureSession`
checked tenant only. Within a tenant, knowing a colleague's session id was
enough to read their conversation — and those conversations contain rates,
contracts and partner credit. Ownership is now tenant **and** user.

### 12. The model was told half the platform did not exist

The union had nineteen command kinds; the system prompt listed ten. Nobody
noticed because nothing compared them. `renderCommandCatalog()` generates the
list from `StructuredCommandSchema`, and a test asserts every kind appears.
**The command language is defined in exactly one place.**

### 13. Two settings did nothing

`POLICY_FLOOR_RATE_ENABLED` was documented and the policy engine supported
`floorRate`, but nothing loaded it: a deployment that believed it had a rate
floor had none. Configuration that silently does nothing is worse than
configuration that is absent, because somebody checked the box and stopped
worrying.

And `Number(process.env.PORT) ?? DEFAULT` is `NaN`, not the default — `??` only
catches null and undefined. Ports are now read per service
(`PORT_<SERVICE>`), so one shared `PORT` cannot make nine services fight over
3100.

### 14. The chat sent the user's message twice

It was persisted, read back as the newest history row, then appended again.
Extra tokens, extra cost, and the last instruction weighted twice.

### 15. A composed view masked a 404 as an outage

The property workspace turned any catalog failure into
`DEPENDENCY_UNAVAILABLE`. A property that does not exist, or is out of scope, is
a 404 — telling an operator the platform is broken when the answer is "no" sends
them to the wrong problem. `settle()` keeps the original error so a caller that
must fail can fail with the real cause.

### 16. The console could render you as somebody else

The last-known-good cache added for resilience covered `/api/v1/me`. When the
platform was unreachable the console answered "who am I" from cache — so
signing in as one user could land you in the previous user's console, with
*their* permission set deciding which screens you were given. It also never
cleared between sessions, so one person's rates and partners survived into the
next person's browser.

A stale rate with its age on it is useful. A stale identity is a lie. Identity
and access-control reads now fail loudly, and changing session clears the cache.

This one was self-inflicted — introduced by the resilience work in ADR-009 and
found because a platform administrator could not sign in as themselves.

### 17. A renamed platform account left an orphan with full authority

The seed keys on email, so changing a platform address CREATED a second account
and left the old one ACTIVE with SUPER_ADMIN and every permission on the
platform. The seed now retires superseded platform accounts — disabled, not
deleted, because the audit trail must still resolve the name.

### 18. A dead back end reported itself as a bug in the login

With the API down, a dev-server proxy or a load balancer answers 500 with an
empty or HTML body. The client turned that into `Request failed (500)` — a
status code with no cause, which sends an operator looking for a defect in
authentication when the API is simply not running. Parsing an HTML error page as
JSON also threw a raw `SyntaxError` at the caller.

A response carrying no platform `error` object did not come from the platform.
It now says so, names the path, and says how to start the API. Rule 11, applied
to the one screen where a confusing failure costs the most.

## What is still not done

- **OIDC/JWKS is not implemented.** The posture gate refuses to start production
  without it, which converts a silent risk into a loud one, but the exchange
  itself is still `[NOT BUILT]`.
- **mTLS between services** — signed context covers authority, not transport
  confidentiality.
- **Field-level PII encryption**, WAF, SBOM and signing in CI.
- **The adversarial AI eval suite** the review recommends. There is no substitute
  for it, and the LLM path has still never run against a live model.
- **Multi-cell ARI writes are still applied cell by cell.** A failure part-way
  leaves earlier cells changed and the action FAILED, and rollback only accepts
  EXECUTED. The blast-radius limit bounds the damage; it does not remove it. This
  needs a batch endpoint and an execution-job model, and it is the largest
  remaining P0.

## Consequences

- Reaching an internal service directly no longer grants anything. The smoke
  suite proves it by trying.
- HIGH-risk confirmation requires a proof bound to that action. The smoke suite
  proves a proof for one action cannot confirm another.
- The assistant cannot exceed its caller. The smoke suite proves a reservations
  agent cannot reach revenue analytics through it.
- A proposal cannot execute after the permission behind it was revoked, or after
  the numbers it was computed on moved.
- 215 unit tests, 113 end-to-end checks.
