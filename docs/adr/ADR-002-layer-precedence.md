# ADR-002 — External, Managed and Effective are three separate things

**Status:** accepted · implemented

## Context

Manual overrides typically overwrite supplier data. The provenance is then gone,
and nobody can answer "what did the hotel actually send us?".

## Decision

`EXTERNAL` and `MANAGED` are separate rows on the same cell key. `Effective` is a
computed projection. A managed value wins field-by-field, and only while its
validity window covers the stay date.

Freshness is measured against the external layer only. A human override must
never make a dead channel-manager feed look alive.

Contractual and promotional adjustments are applied when building an offer and
are never written into the ledger.

## Consequences

An expiring override needs no cleanup job — the external value re-emerges on its
own. Reconciliation can compare source to ledger without a human override looking
like a divergence. The cost is three reads and a merge per cell, which is why
Effective is materialized rather than computed on read.
