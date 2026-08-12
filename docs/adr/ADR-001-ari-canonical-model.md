# ADR-001 — ARI is a versioned ledger, not a mutable row

**Status:** accepted · implemented

## Context

The audited platform exposed ARI as current state. When a hotel disputed a price
or a channel manager insisted it had sent inventory, there was nothing to check.

## Decision

`AriEvent` is append-only. Every row carries `before`, `after`, source and
received timestamps, `payloadHash`, a unique `idempotencyKey`, `correlationId`,
`mappingVersion` and its processing outcome. Rows are written once, with the
outcome already decided, and never updated.

Rejected and out-of-order events are still written.

## Consequences

Replay, debugging, reconciliation, temporal history and explainability all become
queries instead of projects. Storage grows with event volume, so partitioning by
`receivedAt` and a retention policy for raw envelopes are required before scale.

## Rejected alternative

Updating a status column after the fact. A ledger you can edit is a log.
