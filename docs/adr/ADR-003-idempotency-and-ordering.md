# ADR-003 — Exactly-once effect over at-least-once transport

**Status:** accepted · implemented

## Context

Every transport we integrate with is at-least-once. Providers resend, retry and
occasionally deliver out of order. The audit rates duplicate booking from a
non-idempotent retry as P0/critical.

## Decision

Two independent controls on ARI:

1. `idempotencyKey = sha256(source | cellKey | layer | sourceTimestamp | payloadHash)`
   with a unique constraint. A redelivery loses the insert.
2. `AriCell.lastPayloadHash` holds the hash of the cell's *resulting state*. A
   republished snapshot with a fresh timestamp and unchanged content is a no-op.

Ordering prefers a provider sequence when both sides have one, falls back to
`sourceTimestamp`, and on an exact tie with differing content applies and flags —
silently discarding a real change is worse than a recorded ambiguity.

For bookings the key is claimed **before** any external effect and is never
released after one.

## Consequences

A full-snapshot resend costs one read and no writes. Providers without a sequence
get best-effort ordering, and we declare that in their capabilities rather than
implying a guarantee we do not have.
