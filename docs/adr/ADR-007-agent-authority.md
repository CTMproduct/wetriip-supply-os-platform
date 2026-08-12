# ADR-007 — Agent authority is derived, never granted

**Status:** accepted · implemented

## Context

The tempting model is a service account with broad permissions. It is also how
an agent ends up doing something no human involved was allowed to do.

## Decision

`AI permission ≠ user permission`. Effective autonomy is
`min(user.maxAutonomy, platform ceiling)`, and every command is additionally
checked against the invoking user's own grants.

> **Amended by [ADR-008](ADR-008-roles-and-permissions.md).** The per-role
> command table this ADR originally described was replaced by
> `COMMAND_PERMISSIONS`, which maps each command kind to a single permission
> resolved from `role + grants − revokes`. The principle is unchanged and the
> policy check is now named `PERMISSION` rather than `RBAC`; what changed is
> that authority became subtractable and property-scoped.

Three levels:

| Level | Name | Behaviour |
|---|---|---|
| 1 | Observe | Reads and explains. Writes refused outright. |
| 2 | Recommend | Proposes any permitted write; a human confirms. |
| 3 | Execute | May act on LOW/MEDIUM risk without asking. |

HIGH risk always stops for a human and requires step-up authentication, whatever
the level: rate movement beyond the tenant limit, discount beyond the limit,
blast radius beyond the limit, closing inventory, zeroing availability, rollback.

Policy runs **after** simulation, because blast radius, floor rate and resulting
ADR are only knowable once the diff exists. A policy engine that runs first can
only check what the user typed — exactly the set of things a mistaken command
gets wrong.

## Consequences

Raising a tenant's autonomy is a data change, not a deploy. An agent invoked by
a reservation agent is strictly weaker than one invoked by a revenue manager,
with no extra configuration and no way to forget.

Phase-7 autonomy (`AgentPolicy`: a goal plus hard constraints the Revenue Agent
may operate inside) sits on top of this model rather than replacing it.
