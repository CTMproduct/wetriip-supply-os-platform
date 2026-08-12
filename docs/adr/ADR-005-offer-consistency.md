# ADR-005 — Offers are signed, expiring promises, revalidated at booking

**Status:** accepted · implemented

## Context

Between search and booking, ARI moves, promotions expire and contracts get
suspended. The audit rates "offer based on stale ARI" as P0/critical.

## Decision

Every offer carries an HMAC over its price-determining fields and a TTL. Booking
asks three separate questions, deliberately not collapsed into one:

1. is this offer ours and unmodified? (signature)
2. is it still within its promise? (TTL)
3. is the inventory still there? (live re-read of Effective ARI)

Passing 1 and 2 says nothing about 3. A signed, unexpired offer whose room
disappeared four minutes ago must not be sold.

Price drift between the offer and current ARI is recorded but does not block —
we honour the signed price and let reconciliation see the movement.

## Consequences

A tampered offer id or amount fails before a supplier is contacted. Search must
persist offers, which costs a write per result and needs a TTL-based cleanup.
The signing secret becomes a rotation concern.
