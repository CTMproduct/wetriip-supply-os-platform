# ADR-008 — Permissions are the unit of authority; roles are a shorthand

**Status:** accepted · implemented

## Context

A hotel is not one person. The revenue manager moves rates all day, the
e-commerce analyst studies the competitive set and the compset's price moves,
the general manager decides who is allowed to do either — and Wetriip needs to
see all of it, across every tenant, without any tenant being able to see back.

The obvious implementation is a role enum with a `switch` at each write path.
It fails on the first real request, which is always some variant of *"give
Melisa everything except contract publication"* or *"Julián should be able to
run promotions for Cartagena only"*. Roles alone cannot express a subtraction,
and they cannot express a scope. Answering with a new role each time produces
`REVENUE_MANAGER_CTG_NO_CONTRACTS`, which nobody can reason about six months
later — least of all an auditor asking who could have done a thing.

## Decision

**The permission is the unit of authority.** A role is a named bundle of
permissions and nothing more. Resolution is one pure function:

```
effective = ROLE_PERMISSIONS[role]  +  grants  −  revokes
```

with three properties that are deliberate:

1. **Revocation is last and unconditional.** A general manager who takes
   something away must not find the role quietly handing it back. That is the
   single most surprising thing a permission system can do.
2. **Scope is separate from permission.** *What* you may do is a permission;
   *which properties* you may do it to is `propertyIds` (empty means all).
   Folding scope into roles is what produces a role per property.
3. **Autonomy is separate from both.** `maxAutonomy` caps how far the agent may
   go on someone's behalf before a human confirms (ADR-007). A person can hold
   `rates.write` at autonomy 1 — they may change rates, the agent may only
   propose them.

Resolution happens **once, at the gateway**, at login. The resolved list travels
in the request context; no service re-derives it. Enforcement is at the gateway
too, because it is the only component that authenticates a human — internal
services trust the context headers precisely because those headers can only
originate there.

### The three hotel roles this was built for

| Role | Holds | Notably does not hold |
|---|---|---|
| `GENERAL_MANAGER` | `users.manage`, full commercial authority | — |
| `REVENUE_MANAGER` | rates, availability, restrictions, promotions, distribution, `connectivity.sync`, `agent.execute` | `users.manage`, `contracts.publish` |
| `ECOMMERCE` | every `.read`, `partners.read`, `agent.use` | every `.write`, `agent.execute` |

`ECOMMERCE` is the interesting one. It holds `agent.use` but not
`agent.execute`, so an analyst can ask the assistant to raise rates, watch it
build the command, watch it simulate — and watch it be refused, by name, at the
`PERMISSION` check. That refusal is the product, not a gap: the analyst finds
the opportunity and somebody with authority signs it off. Removing `agent.use`
from them would be easier to implement and would delete the job.

`REVENUE_MANAGER` cannot publish a contract. A contract is a commitment the
business signs, not a pricing decision, and the two are confused often enough
that the split is worth the occasional escalation.

### Agent commands inherit, never grant

`COMMAND_PERMISSIONS` maps every `StructuredCommand` kind to the permission it
needs, and the policy engine reads that table. There is no service account and
no agent identity with authority of its own — the agent carries the caller's
resolved permissions and property scope, and nothing else. A test asserts that
every command kind appears in the table and that every mapped permission is
reachable from some role, so a new command cannot ship unenforceable.

### What a hotel administrator may hand out

`assertCanAssign` refuses three things, and each one closes a real path from a
single compromised general-manager account to the whole platform:

- assigning `SUPER_ADMIN` or `SUPPORT` — Wetriip staff are minted by Wetriip
- granting any `PLATFORM_ONLY_PERMISSIONS` — no view across tenants is
  reachable from inside a tenant, however the team is configured
- granting a permission the actor does not hold themselves

`assertNotLastAdministrator` refuses to disable or demote the final active
administrator of an organization. A hotel locked out of its own extranet is a
support incident nobody can resolve from inside.

### Disabled, not deleted

A departed colleague becomes `status: DISABLED`. The account still resolves for
the audit trail — their name must still render against the changes they made —
but `assertCan` returns false for every permission whatever the role says, and
`login()` refuses before a session is ever issued. Deleting the row would leave
the ledger pointing at nothing.

### Wetriip's own view

`platform.tenants.read`, `platform.activity.read` and
`platform.impersonate.read` back `/api/v1/admin/*`. They belong to no hotel
role and cannot be granted from inside a hotel. Everything the platform side
reads is itself an audited read path, and the surface is read-only: seeing what
a tenant did is a support function, acting as them is not.

## Consequences

- Adding a capability means adding a permission and putting it in the bundles
  where it belongs, not writing another `if (role === …)`.
- A permission that no role holds is dead code, and the test suite says so.
- `connectivity.sync` exists separately from `connectivity.manage` because
  refreshing inventory from the channel manager changes no credential and no
  endpoint — it is what the scheduler already does every five minutes, and a
  revenue manager staring at stale ARI must be able to press it.
- The console hides what the caller cannot reach. That is courtesy; every one of
  those routes is enforced again at the gateway, and the smoke suite proves it
  by making the same request as three different people.
