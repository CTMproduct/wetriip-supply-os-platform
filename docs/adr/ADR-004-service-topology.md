# ADR-004 — Split by failure isolation, not by table

**Status:** accepted · implemented · supersedes the modular-monolith draft

## Context

An earlier draft proposed a modular monolith for the MVP, extracting services
only when ownership, volume or scale justified it. That is a defensible default,
and it is the wrong one here.

This product is an agentic extranet. What defines it is the number of
third-party APIs it talks to — dozens of channel managers, PMSs and switches,
each with its own rate limits, latency profile and bad days. The failure to
design against is not "an API is down"; it is "an API is slow, and our workers
pile up behind it until search stops responding for hotels that have nothing to
do with that provider".

## Decision

Eight independently deployable services, drawn along **failure isolation and
scaling curves**:

- `connectivity` is isolated so a slow provider cannot consume the worker pool
  that search and booking depend on. Rate limiting, circuit breaking and
  bulkheads are scoped **per connection**, not per provider.
- `ari-ingestion` is isolated because it is write-heavy, bursty and
  partition-ordered.
- `search` is isolated because it is read-heavy with an 800 ms p95 budget.
- `booking` is isolated because it is low-volume and the highest-criticality
  path.
- `agent` is isolated because LLM latency and cost scale on a different curve
  from everything else.
- Catalog, contracts and promotions stay together in `core-commerce` on purpose:
  transactional, low volume, and they benefit from sharing a transaction.

Stage 1 shares one Postgres instance with **strict table ownership** — a service
reads and writes only its own aggregate and reaches other domains through APIs
and events, never a join.

`services/all-in-one` boots every module in one process for laptops and CI, with
the same code, route prefixes and inter-service HTTP calls.

## Consequences

More moving parts than a monolith, and inter-service calls that could have been
function calls. In exchange, a provider outage is contained, each service scales
on its own driver, and splitting the database later is a configuration change
rather than a rewrite.

The all-in-one host keeps local development to one command, so the distributed
topology is exercised in development and CI rather than avoided until staging.
